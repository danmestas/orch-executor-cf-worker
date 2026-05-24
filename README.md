# orch-executor-cf-worker

Cloudflare Worker executor backend for [orch](https://github.com/danmestas/orch).
Reads a [SpawnSpec][spawn-spec] YAML on stdin, provisions a Cloudflare Worker
running the open-agent NATS bridge, and emits a [WorkerHandle][worker-handle]
YAML on stdout.

[spawn-spec]: https://github.com/danmestas/orch/blob/main/docs/spawn-spec.md
[worker-handle]: https://github.com/danmestas/orch/blob/main/dist/schema/worker-handle.v1.json

## Status

**Phase B — real implementation.** Wraps the open-agent Worker
([`src/worker/index.ts`](src/worker/index.ts)) with the executor-protocol
contract from [orch proposal 0002][0002] / [orch proposal 0003][0003].

[0002]: https://github.com/danmestas/orch/blob/main/docs/proposals/0002-typed-executor-contract.md
[0003]: https://github.com/danmestas/orch/blob/main/docs/proposals/0003-extract-executor-backends.md

## Contract

```
$ orch-executor-cf-worker
  stdin:  SpawnSpec v1 YAML
  stdout: WorkerHandle v1 YAML on success
  stderr: human-readable diagnostics
  exit:   0  success (a handle was emitted — note: a handle with
             status=failed still exits 0 because the dispatcher
             interprets the field)
          64 usage error (bad args, empty stdin)
          65 input error (invalid YAML or schema validation failure)
          70 runtime error (provisioning aborted before a handle
             could be assembled)
```

Schemas are pinned at v1 (committed copies in `schemas/`, generated
from `orch/internal/spawnspec/types.go`). Validation runs on both the
input SpawnSpec and the emitted WorkerHandle.

## How orch-spawn finds this binary

orch-spawn uses hybrid discovery (per orch#142):

1. **Env override:** `ORCH_EXECUTOR_CF_WORKER_CMD` — full command path.
2. **PATH lookup:** `orch-executor-cf-worker` on `$PATH`.
3. **In-tree fallback:** orch's bundled `~/.local/share/orch/executors/cf-worker/spawn`
   (only when the published binary isn't installed).

Install via npm:

```bash
npm install -g @danmestas/orch-executor-cf-worker
orch-executor-cf-worker --version
```

The npm postinstall step is implicit: npm wires the `bin/` entry on
`PATH`. Discovery then resolves automatically.

## Releasing

Releases are driven by tag pushes to `main`.

```bash
# 1. From main with a clean tree, tag the release commit:
git tag v1.0.0
git push origin v1.0.0
```

The push triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. Builds + typechecks + tests against Node 20.
2. Derives the npm version from the tag (`v1.0.0` → `1.0.0`) and rewrites
   `package.json` in place (release-time only — never committed back).
3. Runs `npm publish --access public` to upload
   `@danmestas/orch-executor-cf-worker@<version>`.

The dry-run gate on `ci.yml` (`npm publish --dry-run`) catches packaging
breakage (missing `files`, bad `bin` path) on every PR — so a tag push
shouldn't surprise you.

**One-time secret setup** (operator):

```bash
gh secret set NPM_TOKEN --repo danmestas/orch-executor-cf-worker
# Paste an npm automation token with publish rights to
# @danmestas/orch-executor-cf-worker.
```

**Rehearse without publishing** via the `workflow_dispatch` trigger
("Run workflow" in the GitHub Actions UI) with `dry_run: true` — the
publish step runs as `npm publish --dry-run` and uploads nothing.

## Environment variables

| Variable                              | Purpose                                                                                  | Default                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| `CF_WORKER_URL`                       | Override the deployed Worker base URL (wins over `cf-worker.script`).                    | unset                            |
| `CF_WORKER_HEALTHCHECK`               | Set to `0` / `false` / `off` to skip the readiness probe (handle emits `status=pending`). | enabled                          |
| `CF_WORKER_HEALTHCHECK_TIMEOUT_MS`    | Per-attempt timeout for `GET /health`.                                                   | `5000`                           |
| `CF_WORKER_HEALTHCHECK_RETRIES`       | Number of healthcheck attempts before giving up.                                         | `3`                              |
| `OPEN_AGENT_OWNER`                    | Owner token used in the `agents.prompt.open-agent.<owner>.<session>` bus pattern.        | `SpawnSpec.owner` ∨ `worker`     |

## SpawnSpec example

```yaml
spec_version: v1
name: lead-engineer
agent: claude-code
session: lead-engineer
owner: dmestas

cf-worker:
  script: https://orch-cf-agent.example.workers.dev
  abort_endpoint: /control/abort
```

When `cf-worker.script` is a URL, it's used as the deployed Worker base.
When it's a relative path (e.g. `src/worker/index.ts`), the backend
assumes wrangler-dev on `http://127.0.0.1:8787` and emits a stderr
diagnostic — set `CF_WORKER_URL` to be explicit.

## WorkerHandle example

```yaml
spec_version: v1
name: lead-engineer
agent: claude-code
session: lead-engineer
created_at: 2026-05-24T15:30:00.000Z
executor: cf-worker
id: https://orch-cf-agent.example.workers.dev
bus:
  prompt: agents.prompt.open-agent.dmestas.lead-engineer
  status: agents.status.open-agent.dmestas.lead-engineer
  hb: agents.hb.open-agent.dmestas.lead-engineer
  signal: orch.signal.>.open-agent.dmestas.lead-engineer
abort:
  kind: http-post
  target: https://orch-cf-agent.example.workers.dev/control/abort
status: ready
```

The bus subjects follow the open-agent / Synadia microservice convention:

```
agents.<verb>.open-agent.<owner>.<session>
```

The abort verb is `http-post`: orch-spawn cancels the worker by POSTing
to `abort.target`.

## Deploying the Worker

The Worker source lives at `src/worker/`. To deploy:

```bash
# One-time:
wrangler secret put NATS_WS_URL          # ws://your-hub:8080
wrangler secret put OPENROUTER_API_KEY   # sk-or-...

# Deploy:
wrangler deploy

# Verify:
curl https://<your-worker>.workers.dev/health
```

Local development:

```bash
wrangler dev
# Worker runs at http://127.0.0.1:8787
# In another terminal:
echo "$(cat <<'YAML'
spec_version: v1
name: dev-worker
agent: claude-code
cf-worker:
  script: http://127.0.0.1:8787
YAML
)" | CF_WORKER_URL=http://127.0.0.1:8787 orch-executor-cf-worker
```

See `wrangler.toml` for full configuration. The Worker exposes:

| Route                | Purpose                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `GET /health`        | Liveness probe (used by this executor's healthcheck).                    |
| `POST /agent/<name>` | Bootstrap an open-agent instance bound to the session token `<name>`.   |

Synadia metadata advertised on the NATS bus:

| Field      | Value       |
| ---------- | ----------- |
| `executor` | `wasm`      |
| `location` | `edge`      |
| `lifetime` | `ephemeral` |

## Development

```bash
npm install        # install ajv, yaml, vitest, typescript
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/
npm test           # vitest run
```

The integration test in `test/cli-integration.test.ts` exercises the
full SpawnSpec → WorkerHandle round-trip against a local HTTP stub
that simulates the deployed Worker. It does not require a Cloudflare
account or `wrangler dev`.

For an end-to-end check against the real worker, run `wrangler dev`
from `src/worker/` and point `CF_WORKER_URL` at it manually (see
"Local development" above).

## Phases

| Phase | What happens                                                                          | Status     |
| ----- | ------------------------------------------------------------------------------------- | ---------- |
| **A** | Repo scaffolded (README + MIGRATION + bin stub).                                      | done       |
| **B** | TS sources moved from `orch/executors/wasm/cf-worker/`; CLI implements the contract.  | **this**   |
| **C** | orch deletes `executors/wasm/cf-worker/`; bench installs this binary in Docker.       | next       |

## License

Apache 2.0 (matches orch).
