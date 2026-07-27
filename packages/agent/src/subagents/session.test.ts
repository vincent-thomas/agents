import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubagentDefinition } from "./definitions.ts";
import {
  createSubagentSession,
  subagentToolNames,
} from "./session.ts";

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
  assert.deepEqual(subagentToolNames(definition), [
    "read",
    "write",
    "custom_tool",
    "scout",
  ]);
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
