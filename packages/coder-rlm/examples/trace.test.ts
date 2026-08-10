import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRLMEvent, traceRLMEvent } from "./trace.ts";
import type { RLMEvent } from "../src/index.ts";

const modelUsage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const runUsage = {
  modelCalls: 1,
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const events: RLMEvent[] = [
  { type: "run_start", runId: 0, depth: 0, prompt: "root", contextLength: 0, isLeaf: false },
  {
    type: "run_start",
    runId: 1,
    parentRunId: 0,
    depth: 1,
    prompt: "child",
    contextLength: 12,
    isLeaf: true,
  },
  { type: "model_start", runId: 0, depth: 0, modelCall: 1 },
  { type: "model_end", runId: 0, depth: 0, modelCall: 1, stopReason: "stop", usage: modelUsage },
  { type: "javascript_start", runId: 0, depth: 0, toolCallId: "tool", code: "1 + 1" },
  {
    type: "javascript_end",
    runId: 0,
    depth: 0,
    toolCallId: "tool",
    output: "2",
    isError: false,
  },
  { type: "run_end", runId: 0, depth: 0, result: "done", usage: runUsage },
  { type: "run_error", runId: 0, depth: 0, error: "failed", usage: runUsage },
];

test("formats every RLM event without assuming nested agent events", () => {
  for (const event of events) {
    assert.doesNotThrow(() => formatRLMEvent(event));
  }
  assert.match(formatRLMEvent(events[1]), /recursive call/);
  assert.match(formatRLMEvent(events[2]), /waiting for model/);
});

test("traces model progress through the example callback", () => {
  const output: string[] = [];
  traceRLMEvent(events[2], undefined, (message) => output.push(message));
  assert.deepEqual(output, ["[rlm depth=0] waiting for model (call 1)"]);
});
