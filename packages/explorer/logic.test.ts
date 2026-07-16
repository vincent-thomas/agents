import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EXPLORE_TURNS,
  buildExplorePrompt,
  finishExploreToolExecution,
  formatExploreResult,
  formatExploreToolExecution,
  hasExceededTurnLimit,
  startExploreToolExecution,
} from "./logic.ts";

test("buildExplorePrompt embeds the query and states the read-only constraint", () => {
  const prompt = buildExplorePrompt("where is the retry logic for CI polling?");
  assert.match(prompt, /where is the retry logic for CI polling\?/);
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /cannot write, edit, or run/i);
});

test("formatExploreResult returns the text unchanged when present", () => {
  assert.equal(formatExploreResult("Found it in foo.ts:12"), "Found it in foo.ts:12");
});

test("formatExploreResult falls back when the sub-agent returned nothing", () => {
  assert.equal(
    formatExploreResult(undefined),
    "The exploration sub-agent did not return an answer.",
  );
  assert.equal(formatExploreResult("   "), "The exploration sub-agent did not return an answer.");
});

test("hasExceededTurnLimit trips at the configured cap", () => {
  assert.equal(hasExceededTurnLimit(MAX_EXPLORE_TURNS - 1), false);
  assert.equal(hasExceededTurnLimit(MAX_EXPLORE_TURNS), true);
});

test("explore tool traces track executions without mutating earlier snapshots", () => {
  const empty = [];
  const running = startExploreToolExecution(empty, "call-1", "read", {
    path: "src/index.ts",
    offset: 10,
    limit: 5,
  });
  const finished = finishExploreToolExecution(running, "call-1", false);

  assert.deepEqual(empty, []);
  assert.equal(running[0]?.status, "running");
  assert.equal(finished[0]?.status, "succeeded");
  assert.equal(formatExploreToolExecution(finished[0]!), "read src/index.ts:10-14");
});

test("formatExploreToolExecution summarizes read-only tool arguments", () => {
  const executions = [
    startExploreToolExecution([], "1", "grep", { pattern: "retry", path: "packages" })[0]!,
    startExploreToolExecution([], "2", "find", { pattern: "*.test.ts" })[0]!,
    startExploreToolExecution([], "3", "ls", {})[0]!,
  ];

  assert.deepEqual(executions.map(formatExploreToolExecution), [
    "grep /retry/ in packages",
    "find *.test.ts in .",
    "ls .",
  ]);
});
