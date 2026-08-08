import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContextCompiler } from "../src/context-compiler.ts";
import { evaluateRequirement, objectiveCanSatisfy, reconcileObjective } from "../src/evaluator.ts";
import { JsonStateStore } from "../src/store.ts";
import { transition } from "../src/transitions.ts";
import { commandEvidence, state, tempRepo } from "./helpers.ts";

test("rejects illegal transitions and multiple active objectives", async () => {
  const run = await state(await tempRepo());
  assert.throws(() => transition(run, "root", "satisfied"), /Illegal/);
  run.objectives.child = { ...run.objectives.root, id: "child", status: "ready" };
  assert.throws(() => transition(run, "child", "active"), /already active/);
});

test("transition guards reject unknown prerequisites and unsupported completion", async () => {
  const run = await state(await tempRepo());
  run.objectives.root.status = "proposed";
  run.activeObjectiveId = undefined;
  run.objectives.root.prerequisites = [
    {
      id: "prerequisite",
      description: "unknown prerequisite",
      requirement: { type: "unsupported", name: "unknown" },
    },
  ];
  assert.throws(() => transition(run, "root", "ready"), /prerequisites/);
  run.objectives.root.status = "evaluating";
  assert.throws(() => transition(run, "root", "satisfied"), /supporting evidence/);
});

test("unknown, stale, and unsupported evidence cannot satisfy a predicate", async () => {
  const run = await state(await tempRepo());
  const requirement = { type: "command_exit", command: "true", exitCode: 0 } as const;
  assert.equal(evaluateRequirement(requirement, run).status, "unknown");
  run.evidence.push(commandEvidence(run, { repositoryFingerprint: "stale" }));
  assert.equal(evaluateRequirement(requirement, run).status, "unknown");
  assert.equal(
    evaluateRequirement({ type: "unsupported", name: "semantic proof" }, run).status,
    "unknown",
  );
});

test("violated invariants prevent satisfaction", async () => {
  const run = await state(await tempRepo());
  run.objectives.root.successCriteria = [];
  run.objectives.root.invariants = [
    {
      id: "safe",
      description: "command succeeds",
      requirement: { type: "command_exit", command: "true", exitCode: 0 },
    },
  ];
  run.evidence.push(commandEvidence(run, { exitCode: 1 }));
  assert.equal(objectiveCanSatisfy(run.objectives.root, run), false);
});

test("JSON state is replaced atomically and resumes complete state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coderv2-store-"));
  const run = await state(await tempRepo());
  const store = new JsonStateStore(directory);
  try {
    await store.save(run);
    assert.deepEqual(await store.load(run.runId), run);
    await writeFile(join(directory, "future.json"), JSON.stringify({ ...run, schemaVersion: 2 }));
    await assert.rejects(() => store.load("future"), /Unsupported state schema/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("newer contradictory state invalidates a previously satisfied objective", async () => {
  const run = await state(await tempRepo());
  run.objectives.root.successCriteria = [
    {
      id: "ok",
      description: "true exits zero",
      requirement: { type: "command_exit", command: "true", exitCode: 0 },
    },
  ];
  run.evidence = [commandEvidence(run)];
  run.objectives.root.status = "satisfied";
  assert.equal(objectiveCanSatisfy(run.objectives.root, run), true);
  run.repositoryFingerprint = "new-repository-state";
  const invalidated = reconcileObjective(run, "root");
  assert.equal(invalidated.objectives.root.status, "invalidated");
});

test("context is deterministic, relevant, bounded, and omits unrelated objectives", async () => {
  const run = await state(await tempRepo());
  run.objectives.done = {
    ...run.objectives.root,
    id: "done",
    status: "satisfied",
    intent: "unrelated",
  };
  const compiler = new ContextCompiler({ maxOutputCharacters: 5_000 });
  const first = compiler.compile(run, "root");
  assert.deepEqual(compiler.compile(run, "root"), first);
  assert.equal(JSON.stringify(first).includes("unrelated"), false);
  assert.equal(first.objective.id, "root");
  assert.ok(JSON.stringify(first).length <= 5_000);
});
