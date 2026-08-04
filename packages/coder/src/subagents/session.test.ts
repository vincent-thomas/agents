import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubagentDefinition } from "./definitions.ts";
import { createSubagentSession, subagentToolNames } from "./session.ts";

const definition = parseSubagentDefinition(
  `---
name: worker
label: Worker
description: General worker
model: example/model
thinking: low
prompt: parent
tools: read, write, custom_tool
available_to:
  root: false
  subagents: [scout]
maxTurns: 10
---

Complete the delegated task.
`,
  "worker.md",
);

test("additional agent tools are enabled without duplicating metadata", () => {
  assert.deepEqual(subagentToolNames(definition, ["agent"]), [
    "read",
    "write",
    "custom_tool",
    "agent",
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
