// Unit tests for provisioning logic — bus subject derivation, abort
// verb construction, healthcheck behaviour, and handle assembly.

import { describe, it, expect } from "vitest";
import {
  buildBus,
  buildAbort,
  resolveWorkerUrl,
  probeHealth,
  provision,
} from "../src/spawn.js";
import type { SpawnSpec } from "../src/types.js";

const baseSpec: SpawnSpec = {
  spec_version: "v1",
  name: "lead-agent",
  agent: "claude-code",
  session: "team-alpha",
  owner: "dmestas",
  "cf-worker": {
    script: "https://orch-cf-agent.example.workers.dev",
  },
};

describe("buildBus", () => {
  it("uses owner + session for the open-agent pattern", () => {
    const bus = buildBus(baseSpec, "dmestas");
    expect(bus.prompt).toBe("agents.prompt.open-agent.dmestas.team-alpha");
    expect(bus.status).toBe("agents.status.open-agent.dmestas.team-alpha");
    expect(bus.hb).toBe("agents.hb.open-agent.dmestas.team-alpha");
    expect(bus.signal).toBe("orch.signal.>.open-agent.dmestas.team-alpha");
  });

  it("falls back to name when session is unset", () => {
    const spec = { ...baseSpec, session: undefined };
    const bus = buildBus(spec, "dmestas");
    expect(bus.prompt).toBe("agents.prompt.open-agent.dmestas.lead-agent");
  });
});

describe("buildAbort", () => {
  it("defaults to /control/abort relative to the worker URL", () => {
    const abort = buildAbort(baseSpec, "https://w.example.com");
    expect(abort.kind).toBe("http-post");
    expect(abort.target).toBe("https://w.example.com/control/abort");
  });

  it("honours explicit relative abort_endpoint from the spec", () => {
    const spec = {
      ...baseSpec,
      "cf-worker": { script: baseSpec["cf-worker"]!.script, abort_endpoint: "/api/cancel" },
    };
    const abort = buildAbort(spec, "https://w.example.com");
    expect(abort.target).toBe("https://w.example.com/api/cancel");
  });

  it("honours absolute abort_endpoint from the spec", () => {
    const spec = {
      ...baseSpec,
      "cf-worker": {
        script: baseSpec["cf-worker"]!.script,
        abort_endpoint: "https://other.example.com/abort",
      },
    };
    const abort = buildAbort(spec, "https://w.example.com");
    expect(abort.target).toBe("https://other.example.com/abort");
  });
});

describe("resolveWorkerUrl", () => {
  it("prefers CF_WORKER_URL env override", () => {
    const diag: string[] = [];
    const url = resolveWorkerUrl(baseSpec, { CF_WORKER_URL: "http://localhost:9999/" }, diag);
    expect(url).toBe("http://localhost:9999");
    expect(diag).toEqual([]);
  });

  it("uses spec.cf-worker.script when it is a URL", () => {
    const diag: string[] = [];
    const url = resolveWorkerUrl(baseSpec, {}, diag);
    expect(url).toBe("https://orch-cf-agent.example.workers.dev");
  });

  it("falls back to wrangler-dev default and emits a diagnostic when script is a path", () => {
    const diag: string[] = [];
    const spec = { ...baseSpec, "cf-worker": { script: "src/worker/index.ts" } };
    const url = resolveWorkerUrl(spec, {}, diag);
    expect(url).toBe("http://127.0.0.1:8787");
    expect(diag.length).toBeGreaterThan(0);
  });
});

describe("probeHealth", () => {
  it("returns true on a 2xx healthcheck response", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await probeHealth("http://example", {}, [], fakeFetch);
    expect(ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("retries and gives up after configured retries", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    const diag: string[] = [];
    const ok = await probeHealth(
      "http://example",
      { CF_WORKER_HEALTHCHECK_RETRIES: "2", CF_WORKER_HEALTHCHECK_TIMEOUT_MS: "200" },
      diag,
      fakeFetch,
    );
    expect(ok).toBe(false);
    expect(calls).toBe(2);
    expect(diag.length).toBe(2);
  });

  it("records errored attempts as diagnostics", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const diag: string[] = [];
    const ok = await probeHealth(
      "http://example",
      { CF_WORKER_HEALTHCHECK_RETRIES: "1", CF_WORKER_HEALTHCHECK_TIMEOUT_MS: "200" },
      diag,
      fakeFetch,
    );
    expect(ok).toBe(false);
    expect(diag[0]).toMatch(/ECONNREFUSED/);
  });
});

describe("provision", () => {
  it("emits a ready handle with bus + abort populated when health passes", async () => {
    const fakeFetch = (async () =>
      new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const fixedNow = new Date("2026-05-24T00:00:00.000Z");
    const { handle, diagnostics } = await provision({
      spec: baseSpec,
      env: {},
      now: () => fixedNow,
      fetchImpl: fakeFetch,
    });
    expect(handle.status).toBe("ready");
    expect(handle.executor).toBe("cf-worker");
    expect(handle.created_at).toBe("2026-05-24T00:00:00.000Z");
    expect(handle.bus?.prompt).toBe("agents.prompt.open-agent.dmestas.team-alpha");
    expect(handle.abort?.kind).toBe("http-post");
    expect(handle.abort?.target).toContain("/control/abort");
    expect(handle.id).toBe("https://orch-cf-agent.example.workers.dev");
    expect(diagnostics).toEqual([]);
  });

  it("emits a failed handle when health probe never succeeds", async () => {
    const fakeFetch = (async () =>
      new Response("err", { status: 500 })) as unknown as typeof fetch;
    const { handle } = await provision({
      spec: baseSpec,
      env: { CF_WORKER_HEALTHCHECK_RETRIES: "1", CF_WORKER_HEALTHCHECK_TIMEOUT_MS: "200" },
      fetchImpl: fakeFetch,
    });
    expect(handle.status).toBe("failed");
    expect(handle.message).toMatch(/healthcheck/);
  });

  it("emits a pending handle when healthcheck disabled", async () => {
    const { handle } = await provision({
      spec: baseSpec,
      env: { CF_WORKER_HEALTHCHECK: "0" },
    });
    expect(handle.status).toBe("pending");
    expect(handle.message).toMatch(/disabled/);
  });

  it("falls back to spec.owner then 'worker' when env owner unset", async () => {
    const fakeFetch = (async () =>
      new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const spec = { ...baseSpec, owner: undefined };
    const { handle } = await provision({
      spec,
      env: {},
      fetchImpl: fakeFetch,
    });
    expect(handle.bus?.prompt).toBe("agents.prompt.open-agent.worker.team-alpha");
  });
});
