import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContextCompiler } from "../src/context-compiler.ts";
import { Controller } from "../src/controller.ts";
import { ScriptedPlanner } from "../src/planner.ts";
import { JsonStateStore } from "../src/store.ts";
import { state, tempRepo } from "./helpers.ts";

test("rejects premature completion, verifies, satisfies, and resumes", async () => {
  const repo = await tempRepo();
  const runs = await mkdtemp(join(tmpdir(), "coderv2-runs-"));
  try {
    const initial = await state(repo);
    const contexts: string[] = [];
    const compiler = new ContextCompiler();
    const originalCompile = compiler.compile.bind(compiler);
    compiler.compile = (run, id) => {
      contexts.push(JSON.stringify(originalCompile(run, id)));
      return originalCompile(run, id);
    };
    const planner = new ScriptedPlanner([
      {
        type: "action",
        action: {
          type: "edit",
          patch:
            "diff --git a/proof.txt b/proof.txt\nnew file mode 100644\n--- /dev/null\n+++ b/proof.txt\n@@ -0,0 +1 @@\n+proof\n",
        },
      },
      { type: "finish", objectiveId: "root", evidenceIds: [] },
      { type: "action", action: { type: "command", command: "test -f proof.txt", test: true } },
      { type: "finish", objectiveId: "root", evidenceIds: [] },
    ]);
    const store = new JsonStateStore(runs);
    const result = await new Controller(planner, store, compiler).run(initial);
    assert.equal(result.objectives.root.status, "satisfied");
    assert.equal(result.attempts.length, 2);
    assert.ok(contexts.length >= 4);
    const resumed = await store.load(result.runId);
    assert.equal(resumed.objectives.root.status, "satisfied");
    assert.deepEqual(resumed.objectives.root.evidence, result.objectives.root.evidence);
  } finally {
    await rm(repo, { recursive: true });
    await rm(runs, { recursive: true });
  }
});

test("decomposes generically while preserving one active leaf", async () => {
  const repo = await tempRepo();
  const runs = await mkdtemp(join(tmpdir(), "coderv2-graph-runs-"));
  try {
    const initial = await state(repo);
    initial.objectives.root.successCriteria = [];
    const planner = new ScriptedPlanner([
      {
        type: "action",
        action: {
          type: "decompose",
          objectives: [{ id: "child", intent: "Inspect the fixture", successCriteria: [] }],
        },
      },
      { type: "finish", objectiveId: "child", evidenceIds: [] },
      { type: "finish", objectiveId: "root", evidenceIds: [] },
    ]);
    const result = await new Controller(planner, new JsonStateStore(runs)).run(initial);
    assert.equal(result.objectives.child.status, "satisfied");
    assert.equal(result.objectives.root.status, "satisfied");
    assert.equal(
      Object.values(result.objectives).filter((item) => item.status === "active").length,
      0,
    );
  } finally {
    await rm(repo, { recursive: true });
    await rm(runs, { recursive: true });
  }
});

test("records a model failure and reconstructs the next turn from state", async () => {
  const repo = await tempRepo();
  const runs = await mkdtemp(join(tmpdir(), "coderv2-model-failure-runs-"));
  let calls = 0;
  try {
    const initial = await state(repo);
    initial.objectives.root.successCriteria = [];
    const planner = {
      async propose() {
        calls++;
        if (calls === 1) throw new Error("invalid model output");
        return { type: "finish" as const, objectiveId: "root", evidenceIds: [] };
      },
    };
    const result = await new Controller(planner, new JsonStateStore(runs)).run(initial);
    assert.equal(result.objectives.root.status, "satisfied");
    assert.equal(result.attempts[0].failure, "environment_failure");
    assert.match(result.attempts[0].error ?? "", /invalid model output/);
    assert.equal(calls, 2);
  } finally {
    await rm(repo, { recursive: true });
    await rm(runs, { recursive: true });
  }
});
