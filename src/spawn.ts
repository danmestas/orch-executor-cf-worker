// CF Worker provisioning logic.
//
// Given a validated cf-worker SpawnSpec, this module:
//   1. Resolves the target Worker URL (from spec / env override).
//   2. Health-checks it (the open-agent bootstrap exposes GET /health
//      in src/worker/index.ts).
//   3. Produces a WorkerHandle reflecting what got provisioned.
//
// What this DOESN'T do (yet):
//   - Trigger `wrangler deploy` from inside the executor. Phase B
//     treats the Worker as a pre-deployed artifact; the executor's job
//     is to bridge the SpawnSpec contract to an already-warm Worker
//     URL. A future phase can fold `wrangler deploy` invocation in,
//     once we settle on credential-passing rules. The wrangler-dev
//     integration test in test/ exercises the full bridge via a local
//     dev server.
//
// Environment overrides (read once at spawn time):
//   - CF_WORKER_URL — full base URL of a deployed/warmed Worker, e.g.
//       https://orch-cf-agent.example.workers.dev   (production)
//       http://127.0.0.1:8787                        (wrangler dev)
//     When set, takes precedence over the URL derived from the spec.
//   - CF_WORKER_HEALTHCHECK — "0" / "false" disables the readiness
//     probe (status emits as "pending" with a message). Default: on.
//   - CF_WORKER_HEALTHCHECK_TIMEOUT_MS — per-attempt timeout. Default 5000.
//   - CF_WORKER_HEALTHCHECK_RETRIES — number of attempts. Default 3.
//   - OPEN_AGENT_OWNER — subject-token owner for the open-agent bus
//     pattern. Falls back to SpawnSpec.owner, then "worker".

import type { SpawnSpec, WorkerHandle, BusBlock, AbortBlock } from "./types.js";

export interface ProvisionResult {
  handle: WorkerHandle;
  /** Operator diagnostics — emitted to stderr by the CLI, not stdout. */
  diagnostics: string[];
}

export interface SpawnEnv {
  CF_WORKER_URL?: string;
  CF_WORKER_HEALTHCHECK?: string;
  CF_WORKER_HEALTHCHECK_TIMEOUT_MS?: string;
  CF_WORKER_HEALTHCHECK_RETRIES?: string;
  OPEN_AGENT_OWNER?: string;
}

/**
 * Compute the open-agent NATS subject map for this worker. Pattern:
 *   agents.<verb>.open-agent.<owner>.<session>
 * The "open-agent" middle token identifies this adapter (the open-agent
 * NATS microservice that runs inside the CF Worker). Session falls
 * back to name when unset on the spec.
 */
export function buildBus(spec: SpawnSpec, owner: string): BusBlock {
  const session = spec.session && spec.session.length > 0 ? spec.session : spec.name;
  return {
    prompt: `agents.prompt.open-agent.${owner}.${session}`,
    status: `agents.status.open-agent.${owner}.${session}`,
    hb: `agents.hb.open-agent.${owner}.${session}`,
    signal: `orch.signal.>.open-agent.${owner}.${session}`,
  };
}

/**
 * Build the abort verb for the deployed Worker. For cf-worker we use
 * the http-post kind: POST to the configured abort endpoint (or a
 * sensible default under /control/abort) drains the in-flight bridge.
 */
export function buildAbort(spec: SpawnSpec, workerUrl: string): AbortBlock {
  const cfw = spec["cf-worker"]!;
  const endpoint = cfw.abort_endpoint && cfw.abort_endpoint.length > 0
    ? cfw.abort_endpoint
    : "/control/abort";
  // Combine base URL + endpoint into an absolute URL the dispatcher
  // can POST to directly without re-deriving the worker host.
  const target = endpoint.startsWith("http://") || endpoint.startsWith("https://")
    ? endpoint
    : new URL(endpoint, workerUrl).toString();
  return { kind: "http-post", target };
}

/**
 * Resolve the Worker base URL the dispatcher should treat as the
 * provisioned worker. Env override wins; otherwise pulls from
 * cf-worker.script when it looks like a URL; otherwise defaults to
 * wrangler-dev localhost (with a diagnostic so operators know it's
 * the dev fallback).
 */
export function resolveWorkerUrl(
  spec: SpawnSpec,
  env: SpawnEnv,
  diagnostics: string[],
): string {
  if (env.CF_WORKER_URL && env.CF_WORKER_URL.length > 0) {
    return env.CF_WORKER_URL.replace(/\/+$/, "");
  }
  const script = spec["cf-worker"]!.script;
  if (script.startsWith("http://") || script.startsWith("https://")) {
    return script.replace(/\/+$/, "");
  }
  diagnostics.push(
    `cf-worker.script is not a URL ("${script}"); falling back to wrangler-dev default http://127.0.0.1:8787. Set CF_WORKER_URL to override.`,
  );
  return "http://127.0.0.1:8787";
}

function isHealthcheckDisabled(env: SpawnEnv): boolean {
  const v = env.CF_WORKER_HEALTHCHECK;
  if (v === undefined) return false;
  return v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "off";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Probe GET <workerUrl>/health. Returns true if the worker responds
 * with 2xx; false otherwise (including timeout / network error).
 * Retries are linear with a brief sleep between attempts so the
 * common case (worker booting) gets a fair chance.
 */
export async function probeHealth(
  workerUrl: string,
  env: SpawnEnv,
  diagnostics: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const timeoutMs = parsePositiveInt(env.CF_WORKER_HEALTHCHECK_TIMEOUT_MS, 5000);
  const retries = parsePositiveInt(env.CF_WORKER_HEALTHCHECK_RETRIES, 3);
  const healthUrl = `${workerUrl}/health`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(healthUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) return true;
      diagnostics.push(
        `healthcheck attempt ${attempt}/${retries}: ${healthUrl} returned HTTP ${resp.status}`,
      );
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(
        `healthcheck attempt ${attempt}/${retries}: ${healthUrl} errored: ${msg}`,
      );
    }
    if (attempt < retries) {
      // Brief backoff between attempts. Fixed 250ms — keeps total
      // worst-case bounded at retries*timeoutMs + retries*250ms, which
      // for defaults (3 * 5000 + 3 * 250) is ~15.75s. Acceptable for
      // dispatcher inline use.
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

export interface ProvisionOptions {
  spec: SpawnSpec;
  env: SpawnEnv;
  /** Current time injection point — defaults to Date.now() wrapped. */
  now?: () => Date;
  /** Fetch impl injection point — defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Provision a CF Worker per the SpawnSpec and emit a WorkerHandle.
 * Pure-ish: no global mutation; fetch + clock are injectable for
 * testing.
 */
export async function provision(opts: ProvisionOptions): Promise<ProvisionResult> {
  const { spec, env } = opts;
  const now = opts.now ?? (() => new Date());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const diagnostics: string[] = [];

  const owner = (env.OPEN_AGENT_OWNER && env.OPEN_AGENT_OWNER.length > 0)
    ? env.OPEN_AGENT_OWNER
    : (spec.owner && spec.owner.length > 0)
      ? spec.owner
      : "worker";

  const workerUrl = resolveWorkerUrl(spec, env, diagnostics);
  const bus = buildBus(spec, owner);
  const abort = buildAbort(spec, workerUrl);

  let status: "pending" | "ready" | "failed";
  let message: string | undefined;

  if (isHealthcheckDisabled(env)) {
    status = "pending";
    message = "healthcheck disabled via CF_WORKER_HEALTHCHECK; dispatcher should poll for readiness";
  } else {
    const ok = await probeHealth(workerUrl, env, diagnostics, fetchImpl);
    if (ok) {
      status = "ready";
    } else {
      status = "failed";
      message = `healthcheck at ${workerUrl}/health did not return 2xx after configured retries; see stderr for per-attempt detail`;
    }
  }

  const handle: WorkerHandle = {
    spec_version: "v1",
    name: spec.name,
    agent: spec.agent,
    session: spec.session ?? spec.name,
    created_at: now().toISOString(),
    executor: "cf-worker",
    id: workerUrl,
    bus,
    abort,
    status,
    ...(message ? { message } : {}),
  };

  return { handle, diagnostics };
}
