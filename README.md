# orch-executor-cf-worker
orch executor backend: spawns ephemeral Cloudflare Worker agents (per-request bridge to NATS). Reads SpawnSpec on stdin, emits WorkerHandle on stdout per orch proposal 0002. Extracted from orch/executors/wasm/cf-worker per orch proposal 0003.
