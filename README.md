# orch-executor-cf-worker

Cloudflare Worker executor backend for [orch](https://github.com/danmestas/orch).
Spawns an **ephemeral** open-agent bridge per fetch request — the bridge lives
for the lifetime of the request, then CF tears down the worker.

For a **persistent** bridge that survives across fetches, see the sister
repo [orch-executor-cf-durable-object](https://github.com/danmestas/orch-executor-cf-durable-object).

## Status

**Phase A — scaffold only.** This repo holds the destination structure for
the extraction described in [orch proposal 0003 (issue #142)][0003]. The
actual TypeScript sources still live under `orch/executors/wasm/cf-worker/`
and will move here in **Phase B** once orch's typed SpawnSpec contract
([proposal 0002 / issue #141][0002]) lands.

See [MIGRATION.md](MIGRATION.md) for the per-file move manifest.

[0002]: https://github.com/danmestas/orch/issues/141
[0003]: https://github.com/danmestas/orch/issues/142

## Why a separate repo

Per orch proposal 0003 (Ousterhout-review-adjusted): backends with **heavyweight
dependency footprints** (CF Worker / Durable Object) extract to sister repos
so orch's main repo stops shipping TypeScript + wrangler + miniflare. The
lightweight `tmux` backend stays in-tree — too small (~50 LoC bash) to justify
extraction overhead. This split lets each backend release on its own cadence
in its own language with its own CI.

## How orch finds this backend

orch-spawn discovers backends via PATH lookup or
`~/.local/share/orch/executors/<name>/spawn`. Once installed, this binary
appears as **`orch-executor-cf-worker`** on PATH (npm postinstall wires it).

## Spawn contract (post-Phase B, requires orch #141)

```
$ orch-executor-cf-worker
  stdin:  SpawnSpec YAML (per orch proposal 0002)
  stdout: WorkerHandle YAML on success
  stderr: human-readable diagnostics
  exit:   0 success; non-zero failure
```

Supplementary commands (post-Phase B):

| Command                                | Purpose                                  |
| -------------------------------------- | ---------------------------------------- |
| `orch-executor-cf-worker --version`    | Backend version for orch-version probe   |
| `orch-executor-cf-worker --validate`   | Pre-flight check (no spawn)              |
| `orch-executor-cf-worker --status ID`  | Query worker lifecycle state             |
| `orch-executor-cf-worker --abort ID`   | Imperative cancellation                  |
| `orch-executor-cf-worker --teardown ID`| Cleanup after worker dies                |

Until Phase B lands, the `bin/orch-executor-cf-worker` stub exits 64 with a
"not yet implemented" message and a link back to issue #141.

## Install (Phase B onward)

```bash
npm install -g @danmestas/orch-executor-cf-worker
# postinstall symlinks bin/orch-executor-cf-worker onto PATH
orch-executor-cf-worker --version
```

## What this executor wraps

A Cloudflare Worker that joins a sesh hub as a Synadia agents microservice.
Each incoming `fetch /agent/<session>` runs one agent for the duration of the
NATS connection; the session name maps to:

```
agents.prompt.open-agent.<OPEN_AGENT_OWNER>.<session>
```

Synadia metadata advertised on the bus:

| Field      | Value       |
| ---------- | ----------- |
| `executor` | `wasm`      |
| `location` | `edge`      |
| `lifetime` | `ephemeral` |

## Phases

| Phase | What happens                                                                          | Blocked on |
| ----- | ------------------------------------------------------------------------------------- | ---------- |
| **A** | This repo scaffolded (README + MIGRATION + bin stub). No TS yet.                      | —          |
| **B** | TS sources move from `orch/executors/wasm/cf-worker/`; bin stub wraps `wrangler dev`. | orch #141  |
| **C** | orch deletes `executors/wasm/cf-worker/`; bench installs this binary in Docker.       | Phase B    |

## License

Apache 2.0 (matches orch).
