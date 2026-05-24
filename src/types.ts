// TypeScript shapes for SpawnSpec v1 and WorkerHandle v1.
//
// Authoritative source is Go (`orch/internal/spawnspec/types.go`); JSON
// Schemas in `schemas/` are the validation contract. These TS types are
// a thin convenience layer for the CLI — schema validation is the real
// guard. If TS types and the schema drift, the schema wins at runtime.

export type Agent = "claude-code" | "codex" | "pi" | "gemini" | "echo";

export interface OutfitBlock {
  bundle?: string;
  name?: string;
  cut?: string;
  accessories?: string[];
}

export interface TmuxBlock {
  headless?: boolean;
  verify?: boolean;
  layout?: string;
  position?: string;
  role?: string;
  no_shim?: boolean;
}

export interface CFWorkerBlock {
  /** Path to the worker entrypoint relative to the executor's wrangler root. */
  script: string;
  /** Wrangler environment selector. */
  wrangler_env?: string;
  /** Worker route to POST to for graceful shutdown. */
  abort_endpoint?: string;
}

export interface CFDurableBlock {
  do_namespace: string;
  do_id: string;
}

export interface SpawnSpec {
  spec_version?: "v1";
  name: string;
  description?: string;
  agent: Agent;
  session?: string;
  cwd?: string;
  owner?: string;
  labels?: Record<string, string>;
  outfit?: OutfitBlock;
  env?: Record<string, string>;
  tmux?: TmuxBlock;
  "cf-worker"?: CFWorkerBlock;
  "cf-durable-object"?: CFDurableBlock;
}

export interface BusBlock {
  prompt?: string;
  status?: string;
  hb?: string;
  signal?: string;
}

export interface AbortBlock {
  /** tmux-send-keys | http-post | do-call */
  kind: string;
  target: string;
  keys?: string;
}

export interface WorkerHandle {
  spec_version?: "v1";
  name: string;
  agent: Agent;
  session?: string;
  /** RFC 3339 / ISO 8601 timestamp. */
  created_at: string;
  /** tmux | cf-worker | cf-durable-object */
  executor: string;
  pane_id?: string;
  id?: string;
  bus?: BusBlock;
  abort?: AbortBlock;
  log_file?: string;
  pid?: number;
  /** pending | ready | failed */
  status: string;
  message?: string;
}
