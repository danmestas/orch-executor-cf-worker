// Unit tests for schema + discriminator validation.

import { describe, it, expect } from "vitest";
import { validateSpawnSpec, validateWorkerHandle, ValidationError } from "../src/validate.js";

const minimalCfWorkerSpec = {
  spec_version: "v1",
  name: "test-worker",
  agent: "claude-code",
  "cf-worker": {
    script: "src/worker/index.ts",
  },
};

describe("validateSpawnSpec", () => {
  it("accepts a minimal cf-worker spec", () => {
    const out = validateSpawnSpec({ ...minimalCfWorkerSpec });
    expect(out.name).toBe("test-worker");
    expect(out["cf-worker"]?.script).toBe("src/worker/index.ts");
  });

  it("rejects missing required name", () => {
    const bad = { ...minimalCfWorkerSpec, name: undefined };
    delete (bad as Record<string, unknown>).name;
    expect(() => validateSpawnSpec(bad)).toThrow(ValidationError);
  });

  it("rejects unknown agent enum", () => {
    expect(() =>
      validateSpawnSpec({ ...minimalCfWorkerSpec, agent: "not-a-real-agent" }),
    ).toThrow(/agent/);
  });

  it("rejects no executor block", () => {
    const bad = { ...minimalCfWorkerSpec };
    delete (bad as Record<string, unknown>)["cf-worker"];
    expect(() => validateSpawnSpec(bad)).toThrow(/exactly one executor/);
  });

  it("rejects multiple executor blocks", () => {
    const bad = {
      ...minimalCfWorkerSpec,
      tmux: { headless: false },
    };
    expect(() => validateSpawnSpec(bad)).toThrow(/multiple/);
  });

  it("rejects tmux-only specs (wrong backend)", () => {
    const tmuxSpec = {
      spec_version: "v1",
      name: "test",
      agent: "claude-code",
      tmux: { headless: false },
    };
    expect(() => validateSpawnSpec(tmuxSpec)).toThrow(/wrong backend/);
  });

  it("rejects cf-worker block missing required script", () => {
    const bad = {
      ...minimalCfWorkerSpec,
      "cf-worker": {},
    };
    expect(() => validateSpawnSpec(bad)).toThrow(/script/);
  });

  it("rejects unknown top-level fields", () => {
    const bad = { ...minimalCfWorkerSpec, surprise: "field" };
    expect(() => validateSpawnSpec(bad)).toThrow();
  });

  it("rejects spec_version != v1", () => {
    const bad = { ...minimalCfWorkerSpec, spec_version: "v999" };
    expect(() => validateSpawnSpec(bad)).toThrow();
  });
});

describe("validateWorkerHandle", () => {
  it("accepts a well-formed handle", () => {
    expect(() =>
      validateWorkerHandle({
        spec_version: "v1",
        name: "x",
        agent: "claude-code",
        created_at: new Date().toISOString(),
        executor: "cf-worker",
        status: "ready",
      }),
    ).not.toThrow();
  });

  it("rejects missing required executor", () => {
    expect(() =>
      validateWorkerHandle({
        name: "x",
        agent: "claude-code",
        created_at: new Date().toISOString(),
        // executor missing
        status: "ready",
      } as never),
    ).toThrow();
  });

  it("rejects bad created_at format", () => {
    expect(() =>
      validateWorkerHandle({
        name: "x",
        agent: "claude-code",
        created_at: "not-a-date",
        executor: "cf-worker",
        status: "ready",
      }),
    ).toThrow();
  });
});
