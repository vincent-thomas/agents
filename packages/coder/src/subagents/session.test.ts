import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubagentDefinition } from "./definitions.ts";
import { advanceSubagentTurnLimit, createSubagentSession, subagentToolNames } from "./session.ts";

const definition = parseSubagentDefinition(
  `---
name: worker
label: Worker
description: General worker
model: example/model
thinking: low
prompt: parent
tools: read, write, custom_tool
subagents: [scout]
maxTurns: 10
---

Complete the delegated task.
`,
  "worker.md",
);

test("nested sub-agents are enabled as tools without duplicating metadata", () => {
  assert.deepEqual(subagentToolNames(definition), ["read", "write", "custom_tool", "scout"]);
});

test("reserves a final answer turn before enforcing the turn limit", () => {
  let state = { turnCount: 0, finalTurnRequested: false };

  for (let turn = 1; turn < 10; turn++) {
    const transition = advanceSubagentTurnLimit(state, 10);
    state = transition.state;
    assert.equal(transition.action, "continue");
  }

  const finalRequest = advanceSubagentTurnLimit(state, 10);
  assert.deepEqual(finalRequest, {
    state: { turnCount: 10, finalTurnRequested: true },
    action: "request_final",
  });
  assert.equal(advanceSubagentTurnLimit(finalRequest.state, 10).action, "abort");
});

test("session creation rejects an already-aborted invocation", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    createSubagentSession({
      definition,
      cwd: process.cwd(),
      model: {} as never,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});
