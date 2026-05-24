// Schema validation for SpawnSpec / WorkerHandle YAML messages.
//
// Loads JSON Schemas from `schemas/` (copies of orch's published
// dist/schema/*.v1.json, pinned at v1 — see MIGRATION.md). Uses Ajv
// with format validators so date-time fields in WorkerHandle are
// checked properly.
//
// Validation rules added on top of pure schema:
//   - Executor discriminator: exactly one of tmux / cf-worker /
//     cf-durable-object MUST be set. Schema can't express XOR cleanly,
//     so we enforce here.
//   - This backend only handles cf-worker specs. If a SpawnSpec
//     selects a different executor, we reject — wrong backend
//     dispatched.

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { SpawnSpec, WorkerHandle } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Schemas live at <repo>/schemas. From the built `dist/` directory the
// path is `../schemas`; same when running source-on-source under tsx.
function loadSchema(name: string): object {
  const repoRoot = resolve(__dirname, "..");
  const candidate = resolve(repoRoot, "schemas", name);
  return JSON.parse(readFileSync(candidate, "utf-8"));
}

let cachedAjv: Ajv2020 | null = null;
let cachedSpawnValidator: ValidateFunction | null = null;
let cachedHandleValidator: ValidateFunction | null = null;

function ajv(): Ajv2020 {
  if (cachedAjv) return cachedAjv;
  const instance = new Ajv2020({ allErrors: true, strict: false });
  addFormats(instance);
  cachedAjv = instance;
  return instance;
}

function spawnValidator(): ValidateFunction {
  if (cachedSpawnValidator) return cachedSpawnValidator;
  cachedSpawnValidator = ajv().compile(loadSchema("spawn-spec.v1.json"));
  return cachedSpawnValidator;
}

function handleValidator(): ValidateFunction {
  if (cachedHandleValidator) return cachedHandleValidator;
  cachedHandleValidator = ajv().compile(loadSchema("worker-handle.v1.json"));
  return cachedHandleValidator;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "(no detail)";
  return errors
    .map((e) => {
      const path = e.instancePath || "(root)";
      const detail = e.params ? ` ${JSON.stringify(e.params)}` : "";
      return `  - ${path}: ${e.message}${detail}`;
    })
    .join("\n");
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Validate a parsed SpawnSpec against the schema plus this backend's
 * additional constraints (executor must be cf-worker; XOR on executor
 * discriminator). Throws ValidationError on failure; returns the
 * narrowed spec on success.
 */
export function validateSpawnSpec(input: unknown): SpawnSpec {
  const validate = spawnValidator();
  if (!validate(input)) {
    throw new ValidationError(
      `SpawnSpec failed JSON schema validation:\n${formatErrors(validate.errors)}`,
    );
  }
  // Schema-valid; narrow type now.
  const spec = input as SpawnSpec;

  // Executor discriminator XOR. JSON Schema can express this via oneOf
  // but our copy mirrors the Go-emitted shape which uses optional
  // pointers. Enforce here.
  const present = (["tmux", "cf-worker", "cf-durable-object"] as const).filter(
    (k) => spec[k] !== undefined,
  );
  if (present.length === 0) {
    throw new ValidationError(
      "SpawnSpec must set exactly one executor block (tmux | cf-worker | cf-durable-object); got none",
    );
  }
  if (present.length > 1) {
    throw new ValidationError(
      `SpawnSpec must set exactly one executor block; got multiple: ${present.join(", ")}`,
    );
  }
  // This binary handles cf-worker only.
  if (present[0] !== "cf-worker") {
    throw new ValidationError(
      `orch-executor-cf-worker only handles executor=cf-worker; got ${present[0]} — dispatched to the wrong backend?`,
    );
  }

  return spec;
}

/**
 * Validate a WorkerHandle we're about to emit against the schema.
 * Defence-in-depth: catches drift in our own output shape before we
 * print it to stdout, where orch-spawn would reject it later.
 */
export function validateWorkerHandle(handle: WorkerHandle): void {
  const validate = handleValidator();
  if (!validate(handle)) {
    throw new ValidationError(
      `Emitted WorkerHandle failed schema self-check (this is a bug in orch-executor-cf-worker):\n${formatErrors(validate.errors)}`,
    );
  }
}
