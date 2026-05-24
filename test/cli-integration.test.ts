// CLI round-trip integration test.
//
// Boots a local HTTP server that simulates the wrangler-dev / deployed
// Worker (responds 200 to /health). Pipes a SpawnSpec YAML into the
// compiled CLI as a child process and asserts the stdout contains a
// schema-valid WorkerHandle.
//
// Why a stub server instead of `wrangler dev`:
//   - `wrangler dev` needs CF account / external deps not available in
//     vanilla CI runners. The contract this binary implements (read
//     SpawnSpec, health-probe a Worker URL, emit WorkerHandle) is
//     unaffected by what's behind the URL — a local stub server
//     exercises the same code path with no external dependency.
//   - When a developer wants to verify against real wrangler dev,
//     they can set CF_WORKER_URL=http://127.0.0.1:8787 after
//     `cd src/worker && npx wrangler dev` and re-run the CLI by hand.
//     The README documents this.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { validateWorkerHandle } from "../src/validate.js";
import type { WorkerHandle } from "../src/types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "dist", "cli.js");

interface TestServer {
  server: Server;
  url: string;
}

async function startStubWorker(): Promise<TestServer> {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, agent: "open-agent" }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        rejectServer(new Error("could not resolve listening port"));
        return;
      }
      resolveServer({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function stopServer(s: Server): Promise<void> {
  return new Promise((resolveStop) => s.close(() => resolveStop()));
}

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(
  input: string,
  env: Record<string, string> = {},
): Promise<CliRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      resolveRun({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code: code ?? -1,
      });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe("CLI integration: SpawnSpec → WorkerHandle round-trip", () => {
  let stub: TestServer | null = null;

  beforeAll(async () => {
    stub = await startStubWorker();
  });

  afterAll(async () => {
    if (stub) await stopServer(stub.server);
  });

  it("emits a ready WorkerHandle when the stub Worker responds 200 on /health", async () => {
    const spec = {
      spec_version: "v1",
      name: "integration-test",
      agent: "claude-code",
      session: "team-alpha",
      owner: "dmestas",
      "cf-worker": { script: stub!.url },
    };
    const { stdout, stderr, code } = await runCli(stringifyYaml(spec));
    expect(code, `exit non-zero; stderr was:\n${stderr}`).toBe(0);
    const parsed = parseYaml(stdout) as WorkerHandle;
    expect(parsed.status).toBe("ready");
    expect(parsed.executor).toBe("cf-worker");
    expect(parsed.name).toBe("integration-test");
    expect(parsed.bus?.prompt).toBe("agents.prompt.open-agent.dmestas.team-alpha");
    expect(parsed.abort?.kind).toBe("http-post");
    expect(parsed.abort?.target).toBe(`${stub!.url}/control/abort`);
    expect(parsed.id).toBe(stub!.url);
    // Self-schema-check (defence-in-depth — CLI already does this
    // before emit, but assert here too).
    expect(() => validateWorkerHandle(parsed)).not.toThrow();
  });

  it("emits a failed WorkerHandle (still exit 0) when the worker URL is unreachable", async () => {
    const spec = {
      spec_version: "v1",
      name: "unreachable-test",
      agent: "claude-code",
      "cf-worker": { script: "http://127.0.0.1:1" },
    };
    const { stdout, code } = await runCli(stringifyYaml(spec), {
      CF_WORKER_HEALTHCHECK_RETRIES: "1",
      CF_WORKER_HEALTHCHECK_TIMEOUT_MS: "200",
    });
    expect(code).toBe(0);
    const parsed = parseYaml(stdout) as WorkerHandle;
    expect(parsed.status).toBe("failed");
    expect(parsed.message).toMatch(/healthcheck/);
  });

  it("exits non-zero with stderr error on invalid SpawnSpec YAML", async () => {
    const bad = "not: [valid yaml";
    const { stderr, code, stdout } = await runCli(bad);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/invalid YAML|YAMLParse/);
    expect(stdout).toBe("");
  });

  it("exits non-zero with stderr error on schema-invalid SpawnSpec", async () => {
    const spec = {
      // missing required fields name + agent
      "cf-worker": { script: "foo" },
    };
    const { stderr, code, stdout } = await runCli(stringifyYaml(spec));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/SpawnSpec failed JSON schema validation/);
    expect(stdout).toBe("");
  });

  it("exits non-zero when a tmux SpawnSpec is sent to this backend", async () => {
    const spec = {
      spec_version: "v1",
      name: "wrong-backend-test",
      agent: "claude-code",
      tmux: { headless: false },
    };
    const { stderr, code } = await runCli(stringifyYaml(spec));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/wrong backend|executor=cf-worker/);
  });

  it("--version prints a version line and exits 0", async () => {
    const { stdout, code } = await runCli("", {});
    // empty stdin should fail; we use a separate invocation for --version
    void stdout;
    expect(code).not.toBe(0);

    // Now the actual --version invocation.
    const child = await new Promise<CliRun>((resolveRun, rejectRun) => {
      const c = spawn(process.execPath, [cliPath, "--version"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      c.stdout.on("data", (b: Buffer) => out.push(b));
      c.stderr.on("data", (b: Buffer) => err.push(b));
      c.on("error", rejectRun);
      c.on("exit", (code2) =>
        resolveRun({
          stdout: Buffer.concat(out).toString("utf-8"),
          stderr: Buffer.concat(err).toString("utf-8"),
          code: code2 ?? -1,
        }),
      );
      c.stdin.end();
    });
    expect(child.code).toBe(0);
    expect(child.stdout).toMatch(/^orch-executor-cf-worker \d+\.\d+\.\d+/);
  });
});
