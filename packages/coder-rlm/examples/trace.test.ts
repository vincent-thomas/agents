import assert from "node:assert/strict";
import { test } from "node:test";
import type { RLMEvent } from "../src/index.ts";
import { createRLMEventTracer, formatRLMEvent, RLMEventRenderer, traceRLMEvent } from "./trace.ts";

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

const rootStart: RLMEvent = {
  type: "run_start",
  runId: 0,
  depth: 0,
  prompt: "root",
  contextLength: 0,
  isLeaf: false,
};

const childHandle = (id: number, name: string, parentRunId: number, depth: number) => ({
  id,
  name,
  parentRunId,
  depth,
});

test("renders a root run with an identity-based root prefix", () => {
  const renderer = new RLMEventRenderer();
  assert.equal(renderer.format(rootStart), "[rlm root] start: root (external context: 0 chars)");
  assert.equal(
    renderer.format({ type: "model_start", runId: 0, depth: 0, modelCall: 1 }),
    "[rlm root] waiting for model (call 1)",
  );
  assert.doesNotMatch(
    renderer.format({ type: "run_end", runId: 0, depth: 0, result: "done", usage: runUsage }),
    /depth=/,
  );
});

test("uses child names and parent relationships for nested tree branches", () => {
  const renderer = new RLMEventRenderer();
  renderer.format(rootStart);
  renderer.format({
    type: "child_spawn",
    runId: 0,
    parentRunId: 0,
    depth: 0,
    handle: childHandle(1, "research", 0, 1),
    prompt: "research",
    contextLength: 12,
  });
  renderer.format({
    type: "child_start",
    runId: 1,
    parentRunId: 0,
    depth: 1,
    handle: childHandle(1, "research", 0, 1),
  });
  assert.equal(
    renderer.format({
      type: "run_start",
      runId: 1,
      parentRunId: 0,
      depth: 1,
      prompt: "research",
      contextLength: 12,
      isLeaf: false,
    }),
    "[rlm root/research#1] recursive start: research (external context: 12 chars)",
  );
  renderer.format({
    type: "child_spawn",
    runId: 1,
    parentRunId: 1,
    depth: 1,
    handle: childHandle(2, "summarize", 1, 2),
    prompt: "summarize",
    contextLength: 4,
  });
  assert.equal(
    renderer.format({
      type: "child_start",
      runId: 2,
      parentRunId: 1,
      depth: 2,
      handle: childHandle(2, "summarize", 1, 2),
    }),
    "[rlm root/research#1/summarize#2] child started",
  );
});

test("keeps parallel sibling prefixes stable while events interleave", () => {
  const renderer = new RLMEventRenderer();
  renderer.format(rootStart);
  const left = childHandle(1, "left", 0, 1);
  const right = childHandle(2, "right", 0, 1);
  renderer.format({
    type: "child_spawn",
    runId: 0,
    parentRunId: 0,
    depth: 0,
    handle: left,
    prompt: "left",
    contextLength: 1,
  });
  renderer.format({
    type: "child_spawn",
    runId: 0,
    parentRunId: 0,
    depth: 0,
    handle: right,
    prompt: "right",
    contextLength: 1,
  });
  renderer.format({ type: "child_start", runId: 2, parentRunId: 0, depth: 1, handle: right });
  renderer.format({ type: "child_start", runId: 1, parentRunId: 0, depth: 1, handle: left });

  const rightEvent = renderer.format({
    type: "model_start",
    runId: 2,
    parentRunId: 0,
    depth: 1,
    modelCall: 2,
  });
  const leftEvent = renderer.format({
    type: "model_start",
    runId: 1,
    parentRunId: 0,
    depth: 1,
    modelCall: 3,
  });
  const rightAgain = renderer.format({
    type: "model_end",
    runId: 2,
    parentRunId: 0,
    depth: 1,
    modelCall: 2,
    stopReason: "stop",
    usage: modelUsage,
  });
  assert.match(rightEvent, /^\[rlm root\/right#2\]/);
  assert.match(leftEvent, /^\[rlm root\/left#1\]/);
  assert.match(rightAgain, /^\[rlm root\/right#2\]/);
  assert.notEqual(
    rightEvent.slice(0, rightEvent.indexOf("]") + 1),
    leftEvent.slice(0, leftEvent.indexOf("]") + 1),
  );
});

test("suppresses successful JavaScript bodies but retains a concise start and completion", () => {
  const renderer = new RLMEventRenderer();
  renderer.format(rootStart);
  const start = renderer.format({
    type: "javascript_start",
    runId: 0,
    depth: 0,
    toolCallId: "tool",
    code: "secretResult = veryLargeValue()",
  });
  const end = renderer.format({
    type: "javascript_end",
    runId: 0,
    depth: 0,
    toolCallId: "tool",
    output: "secret output body",
    isError: false,
  });
  assert.equal(start, "[rlm root] javascript start");
  assert.equal(end, "[rlm root] javascript complete");
  assert.doesNotMatch(`${start}\n${end}`, /secretResult|secret output body/);
});

test("keeps JavaScript errors concise without captured output", () => {
  const renderer = new RLMEventRenderer(240);
  renderer.format(rootStart);
  const line = renderer.format({
    type: "javascript_end",
    runId: 0,
    depth: 0,
    toolCallId: "tool",
    output: "TypeError: boom\n\nConsole output:\nSECRET_CAPTURED_VALUE",
    isError: true,
  });
  assert.equal(line, "[rlm root] javascript error: TypeError: boom");
  assert.doesNotMatch(line, /SECRET_CAPTURED_VALUE|Console output/);
});

test("sanitizes child names used in branch prefixes", () => {
  const renderer = new RLMEventRenderer();
  renderer.format(rootStart);
  const handle = childHandle(1, "bad]\u001b[31m/name", 0, 1);
  renderer.format({
    type: "child_start",
    runId: 1,
    parentRunId: 0,
    depth: 1,
    handle,
  });
  const line = renderer.format({
    type: "model_start",
    runId: 1,
    parentRunId: 0,
    depth: 1,
    modelCall: 2,
  });
  assert.equal(line, "[rlm root/bad-31m-name#1] waiting for model (call 2)");
  assert.doesNotMatch(line, /\u001b|\]\/|\/name/);
});

test("resets branch state between sequential top-level runs", () => {
  const renderer = new RLMEventRenderer();
  renderer.format(rootStart);
  renderer.format({
    type: "child_start",
    runId: 1,
    parentRunId: 0,
    depth: 1,
    handle: childHandle(1, "first", 0, 1),
  });
  renderer.format({ type: "run_end", runId: 0, depth: 0, result: "done", usage: runUsage });

  renderer.format({ ...rootStart, prompt: "second root" });
  renderer.format({
    type: "child_start",
    runId: 1,
    parentRunId: 0,
    depth: 1,
    handle: childHandle(1, "second", 0, 1),
  });
  const line = renderer.format({
    type: "model_start",
    runId: 1,
    parentRunId: 0,
    depth: 1,
    modelCall: 1,
  });
  assert.match(line, /^\[rlm root\/second#1\]/);
  assert.doesNotMatch(line, /first/);

  renderer.format({ type: "run_error", runId: 0, depth: 0, error: "failed", usage: runUsage });
  renderer.format({ ...rootStart, prompt: "third root" });
  renderer.format({
    type: "child_start",
    runId: 1,
    parentRunId: 0,
    depth: 1,
    handle: childHandle(1, "third", 0, 1),
  });
  assert.match(
    renderer.format({
      type: "model_start",
      runId: 1,
      parentRunId: 0,
      depth: 1,
      modelCall: 1,
    }),
    /^\[rlm root\/third#1\]/,
  );
});

test("formats isolated events and supports a stateful callback tracer", () => {
  assert.match(
    formatRLMEvent({
      type: "model_end",
      runId: 0,
      depth: 0,
      modelCall: 1,
      stopReason: "stop",
      usage: modelUsage,
    }),
    /^\[rlm root\]/,
  );
  const output: string[] = [];
  traceRLMEvent({ type: "model_start", runId: 0, depth: 0, modelCall: 1 }, undefined, (message) =>
    output.push(message),
  );
  assert.deepEqual(output, ["[rlm root] waiting for model (call 1)"]);

  const traced: string[] = [];
  const trace = createRLMEventTracer(undefined, (message) => traced.push(message));
  trace(rootStart);
  trace({ type: "model_start", runId: 0, depth: 0, modelCall: 1 });
  assert.deepEqual(
    traced.map((line) => line.slice(0, line.indexOf("]") + 1)),
    ["[rlm root]", "[rlm root]"],
  );
});
