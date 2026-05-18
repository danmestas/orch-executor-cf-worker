# Phase B file-move manifest (orch → orch-executor-cf-worker)

Tracks the exact files that move from `orch/executors/wasm/cf-worker/` to this
repo in Phase B of [orch proposal 0003][0003]. **Nothing has moved yet** —
this file is the contract that Phase B's PR will execute against.

[0003]: https://github.com/danmestas/orch/blob/main/docs/proposals/0003-extract-executor-backends.md

## Move-as-is (verbatim, paths rewritten)

| Source (in `danmestas/orch`)                 | Destination (in this repo) |
| -------------------------------------------- | -------------------------- |
| `executors/wasm/cf-worker/src/index.ts`      | `src/index.ts`             |
| `executors/wasm/cf-worker/src/local-sandbox.ts` | `src/local-sandbox.ts`  |
| `executors/wasm/cf-worker/wrangler.toml`     | `wrangler.toml`            |
| `executors/wasm/cf-worker/package.json`      | `package.json` (renamed pkg to `@danmestas/orch-executor-cf-worker`, `private: false`) |
| `executors/wasm/cf-worker/tsconfig.json`     | `tsconfig.json`            |
| `executors/wasm/cf-worker/README.md`         | merge into `README.md` (operator-facing sections) |

## New in this repo (no orch counterpart)

| File                                    | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `bin/orch-executor-cf-worker`           | SpawnSpec stdin → WorkerHandle stdout; wraps `wrangler dev` / `wrangler deploy` per spec. **Phase A: stub exits 64.** |
| `bin/orch-executor-cf-worker --version` | Version probe for orch-version backend discovery     |
| `MIGRATION.md`                          | This file                                            |
| `.github/workflows/ci.yml`              | TypeScript typecheck + `wrangler deploy --dry-run` on PR |
| `LICENSE`                               | Apache 2.0 (matches orch)                            |

## Deleted from orch (Phase C)

After Phase B merges and this backend is published, the orch-side PR deletes:

```
orch/executors/wasm/cf-worker/    (entire directory)
```

…and updates `docs/multi-executor-workers.md` to point readers here.

## Why these specific files

The `src/`, `wrangler.toml`, `package.json`, `tsconfig.json` set together
forms the deployable Worker. None of it is reused by other orch components,
so the move is clean. The README is partially merged (deployment + spawn
contract sections come over; orch-internal references stay there or get
rewritten).

## Why these files do NOT move

| File                                | Why it stays in orch                              |
| ----------------------------------- | ------------------------------------------------- |
| `executors/tmux/spawn.sh`           | Lightweight backend (~50 LoC bash) stays in orch per Ousterhout-review (proposal 0003 §scope) |
| Anything under `internal/spawnspec/` | Future orch package (proposal 0002); shared contract, lives in orch |
| `docs/multi-executor-workers.md`    | Operator-facing roadmap; updated in Phase C to link here |
| `test/docker-sesh/`                 | Bench fixtures; updated in Phase C to install this binary in Docker |
