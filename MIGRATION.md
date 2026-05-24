# Phase B file-move manifest (orch → orch-executor-cf-worker)

Tracks the files that moved from `orch/executors/wasm/cf-worker/` to this
repo in Phase B of [orch proposal 0003][0003]. Phase B is now landed —
this file remains as a record. Phase C deletes the orch-side copies.

[0003]: https://github.com/danmestas/orch/blob/main/docs/proposals/0003-extract-executor-backends.md

## Moved (Phase B)

| Source (in `danmestas/orch`)                    | Destination (in this repo)            |
| ----------------------------------------------- | ------------------------------------- |
| `executors/wasm/cf-worker/src/index.ts`         | `src/worker/index.ts`                 |
| `executors/wasm/cf-worker/src/local-sandbox.ts` | `src/worker/local-sandbox.ts`         |
| `executors/wasm/cf-worker/wrangler.toml`        | `wrangler.toml`                       |
| `executors/wasm/cf-worker/tsconfig.json`        | `tsconfig.worker.json` (worker-only)  |

The Worker entrypoint (`src/worker/index.ts`) is unmodified — it is
still the deployable artifact bootstrapping open-agent over NATS
WebSockets. The Phase B work wraps that Worker with the executor-protocol
contract: see `src/cli.ts`.

## New in Phase B

| File                                | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `src/cli.ts`                        | Entry point: reads SpawnSpec stdin, emits WorkerHandle stdout.          |
| `src/spawn.ts`                      | Provisioning logic (bus subject derivation, abort verb, healthcheck).   |
| `src/validate.ts`                   | Ajv-based schema validation for SpawnSpec + WorkerHandle.               |
| `src/types.ts`                      | TS shapes mirroring `orch/internal/spawnspec/types.go`.                 |
| `schemas/spawn-spec.v1.json`        | Pinned copy of orch's `dist/schema/spawn-spec.v1.json`.                 |
| `schemas/worker-handle.v1.json`     | Pinned copy of orch's `dist/schema/worker-handle.v1.json`.              |
| `test/validate.test.ts`             | Schema + discriminator validation unit tests.                           |
| `test/spawn.test.ts`                | Bus / abort / healthcheck / provisioning unit tests.                    |
| `test/cli-integration.test.ts`      | End-to-end CLI round-trip against a local HTTP stub Worker.             |
| `tsconfig.json`                     | CLI-side TS config (emits `dist/`).                                     |
| `tsconfig.worker.json`              | Worker-side TS config (typecheck only, separate lib).                   |
| `vitest.config.ts`                  | Test runner config.                                                     |
| `.github/workflows/ci.yml`          | CI: install, typecheck, build, test, version-probe on Node 20/22.       |

## Schema upkeep

The schemas under `schemas/` are committed copies of orch's published
`dist/schema/*.v1.json`. When orch bumps v1 (or adds v2), this repo
imports the new file and regenerates fixtures. The version pin in
`spec_version: v1` is the firewall — backends ignore unknown versions.

## Phase C (after Phase B merges)

Phase C deletes the orch-side directory:

```
orch/executors/wasm/cf-worker/
```

…and updates `orch/docs/multi-executor-workers.md` to point readers
here. Tracking issue in orch.
