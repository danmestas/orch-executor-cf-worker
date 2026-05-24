#!/usr/bin/env node
// orch-executor-cf-worker — CF Worker backend for orch's typed executor
// protocol (orch proposal 0002).
//
// Contract:
//   stdin:  SpawnSpec YAML
//   stdout: WorkerHandle YAML on success
//   stderr: human-readable diagnostics
//   exit:   0 success; non-zero failure
//
// See README.md for discovery (how orch-spawn finds this binary), env
// vars, and example inputs/outputs.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { provision, type SpawnEnv } from "./spawn.js";
import { validateSpawnSpec, validateWorkerHandle, ValidationError } from "./validate.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const VERSION_FALLBACK = "0.1.0";

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli.js → ../package.json
    const candidates = [
      resolve(here, "..", "package.json"),
      resolve(here, "..", "..", "package.json"),
    ];
    for (const path of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(path, "utf-8"));
        if (pkg && typeof pkg.version === "string") return pkg.version;
      } catch {
        // try next
      }
    }
  } catch {
    // fall through
  }
  return VERSION_FALLBACK;
}

function printUsage(stream: NodeJS.WriteStream): void {
  stream.write(`\
orch-executor-cf-worker — Cloudflare Worker executor backend for orch.

Usage:
  echo "<spawnspec-yaml>" | orch-executor-cf-worker
  orch-executor-cf-worker --version
  orch-executor-cf-worker --help

The default mode reads a SpawnSpec YAML on stdin and writes a
WorkerHandle YAML to stdout. See README.md for the full contract,
discovery rules, and environment overrides.
`);
}

async function readStdinUtf8(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function pickEnv(source: NodeJS.ProcessEnv): SpawnEnv {
  return {
    CF_WORKER_URL: source.CF_WORKER_URL,
    CF_WORKER_HEALTHCHECK: source.CF_WORKER_HEALTHCHECK,
    CF_WORKER_HEALTHCHECK_TIMEOUT_MS: source.CF_WORKER_HEALTHCHECK_TIMEOUT_MS,
    CF_WORKER_HEALTHCHECK_RETRIES: source.CF_WORKER_HEALTHCHECK_RETRIES,
    OPEN_AGENT_OWNER: source.OPEN_AGENT_OWNER,
  };
}

export async function main(argv: string[]): Promise<number> {
  // Flag handling — minimal, no third-party arg parser needed.
  const args = argv.slice(2);

  if (args.includes("--version") || args.includes("-V")) {
    process.stdout.write(`orch-executor-cf-worker ${readPackageVersion()}\n`);
    return 0;
  }
  if (args.includes("--help") || args.includes("-h")) {
    printUsage(process.stdout);
    return 0;
  }
  if (args.length > 0) {
    process.stderr.write(
      `orch-executor-cf-worker: unrecognised arguments: ${args.join(" ")}\n` +
      `Run with --help for usage.\n`,
    );
    return 64;
  }

  // Read stdin to EOF.
  const stdinRaw = await readStdinUtf8();
  if (stdinRaw.trim().length === 0) {
    process.stderr.write(
      "orch-executor-cf-worker: stdin was empty; expected a SpawnSpec YAML.\n",
    );
    return 64;
  }

  // Parse YAML.
  let parsed: unknown;
  try {
    parsed = parseYaml(stdinRaw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`orch-executor-cf-worker: invalid YAML on stdin: ${msg}\n`);
    return 65;
  }

  // Schema-validate the parsed spec.
  let spec;
  try {
    spec = validateSpawnSpec(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`orch-executor-cf-worker: ${err.message}\n`);
      return 65;
    }
    throw err;
  }

  // Provision the worker and assemble the handle.
  const env = pickEnv(process.env);
  let result;
  try {
    result = await provision({ spec, env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`orch-executor-cf-worker: provision failed: ${msg}\n`);
    return 70;
  }

  // Echo operator diagnostics to stderr — never stdout, where the
  // dispatcher is parsing YAML.
  for (const line of result.diagnostics) {
    process.stderr.write(`orch-executor-cf-worker: ${line}\n`);
  }

  // Self-validate before emit — defence in depth.
  try {
    validateWorkerHandle(result.handle);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`orch-executor-cf-worker: ${err.message}\n`);
      return 70;
    }
    throw err;
  }

  // Emit handle to stdout.
  process.stdout.write(stringifyYaml(result.handle));

  // status=failed still exits 0: the dispatcher reads the handle and
  // surfaces the failure to the operator. Reserving non-zero exits
  // for protocol-level failures (couldn't parse, couldn't run) keeps
  // the contract clean.
  return 0;
}

// Top-level only when invoked directly (allow importing for tests).
const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  // dist/cli.js or src/cli.ts when developing
  /\bcli\.(js|ts|mjs)$/.test(process.argv[1]);

if (isDirectInvocation) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`orch-executor-cf-worker: unexpected error: ${msg}\n`);
      process.exit(70);
    },
  );
}
