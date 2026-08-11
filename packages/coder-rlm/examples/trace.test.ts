import assert from "node:assert/strict";
import { test } from "node:test";
import type { RLMEvent } from "../src/index.ts";
import {
  createRLMEventTracer,
  formatRLMEvent,
  RLMEventDashboard,
  RLMEventRenderer,
  traceRLMEvent,
} from "./trace.ts";

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
  tier: "balanced" as const,
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
  assert.equal(
    renderer.format({
      type: "child_spawn",
      runId: 0,
      parentRunId: 0,
      depth: 0,
      handle: childHandle(1, "research", 0, 1),
      tier: "balanced",
      prompt: "research",
      contextLength: 12,
    }),
    "[rlm root] spawned research#1 [balanced] (context: 12 chars)",
  );
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
    tier: "balanced",
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
    tier: "balanced",
    prompt: "left",
    contextLength: 1,
  });
  renderer.format({
    type: "child_spawn",
    runId: 0,
    parentRunId: 0,
    depth: 0,
    handle: right,
    tier: "balanced",
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

test("TTY snapshots show limits, state transitions, and hide numeric IDs", () => {
  let time = 1_000;
  const dashboard = new RLMEventDashboard({ maxModelCalls: 8, maxDepth: 3, now: () => time });
  const snapshot = dashboard.render({ ...rootStart, prompt: "Analyze the repository" });
  assert.match(snapshot, /model calls: 0\/8/);
  assert.match(snapshot, /active agents: 1/);
  assert.match(snapshot, /depth: 0\/3/);
  assert.match(snapshot, /request — Analyze the repository — waiting for model/);
  const left = childHandle(1, "left", 0, 1);
  const right = childHandle(2, "right", 0, 1);
  dashboard.render({
    type: "child_spawn",
    runId: 0,
    parentRunId: 0,
    depth: 0,
    handle: left,
    tier: "balanced",
    prompt: "left",
    contextLength: 1,
  });
  dashboard.render({
    type: "child_spawn",
    runId: 0,
    parentRunId: 0,
    depth: 0,
    handle: right,
    tier: "fast",
    prompt: "right",
    contextLength: 1,
  });
  time += 1_250;
  const active = dashboard.render({
    type: "model_start",
    runId: 2,
    parentRunId: 0,
    depth: 1,
    modelCall: 2,
  });
  assert.match(active, /├─ left — waiting for model/);
  assert.match(active, /└─ right — reasoning\/model/);
  assert.match(active, /elapsed: 1\.3s/);
  assert.doesNotMatch(active, /#1|#2|root/);
});

test("dashboard keys children by runId rather than handle id and drains after root terminal", () => {
  const dashboard = new RLMEventDashboard();
  const handle = childHandle(1, "worker", 10, 1);
  dashboard.render({ ...rootStart, runId: 10 });
  dashboard.render({
    type: "child_spawn",
    runId: 10,
    parentRunId: 10,
    depth: 0,
    handle,
    tier: "balanced",
    prompt: "work",
    contextLength: 1,
  });
  dashboard.render({ type: "child_start", runId: 99, parentRunId: 10, depth: 1, handle });
  dashboard.render({ type: "run_end", runId: 10, depth: 0, result: "root", usage: runUsage });
  assert.equal(dashboard.isComplete(), false);
  assert.match(dashboard.snapshot(), /worker — waiting for model/);
  dashboard.render({
    type: "child_end",
    runId: 99,
    parentRunId: 10,
    depth: 1,
    result: { handle, tier: "balanced", status: "succeeded", text: "done" },
  });
  assert.equal(dashboard.isComplete(), true);
  assert.match(dashboard.snapshot(), /✓ 1 completed/);
  assert.doesNotMatch(dashboard.snapshot(), /#1|#99/);
});

test("dashboard aggregates successful high-fanout siblings", () => {
  const dashboard = new RLMEventDashboard();
  dashboard.render(rootStart);
  for (let id = 1; id <= 5; id++) {
    const handle = childHandle(id, `worker-${id}`, 0, 1);
    const runId = 100 + id;
    dashboard.render({
      type: "child_spawn",
      runId: 0,
      parentRunId: 0,
      depth: 0,
      handle,
      tier: "fast",
      prompt: "work",
      contextLength: 1,
    });
    dashboard.render({ type: "child_start", runId, parentRunId: 0, depth: 1, handle });
    dashboard.render({
      type: "child_end",
      runId,
      parentRunId: 0,
      depth: 1,
      result: { handle, tier: "fast", status: "succeeded", text: "done" },
    });
  }
  const snapshot = dashboard.render({
    type: "run_end",
    runId: 0,
    depth: 0,
    result: "done",
    usage: runUsage,
  });
  assert.match(snapshot, /✓ 5 completed/);
  assert.doesNotMatch(snapshot, /worker-[1-5]/);
});

test("dashboard JavaScript errors wait for recovery without changing active count", () => {
  const dashboard = new RLMEventDashboard();
  dashboard.render(rootStart);
  dashboard.render({
    type: "javascript_start",
    runId: 0,
    depth: 0,
    toolCallId: "tool",
    code: "bad",
  });
  const errored = dashboard.render({
    type: "javascript_end",
    runId: 0,
    depth: 0,
    toolCallId: "tool",
    output: "TypeError: bad",
    isError: true,
  });
  assert.match(errored, /active agents: 1/);
  assert.match(errored, /waiting for model/);
  assert.match(errored, /JavaScript error: TypeError: bad/);
  const recovered = dashboard.render({
    type: "javascript_end",
    runId: 0,
    depth: 0,
    toolCallId: "tool",
    output: "ok",
    isError: false,
  });
  assert.doesNotMatch(recovered, /JavaScript error/);
});

test("dashboard resets for sequential top-level runs", () => {
  const dashboard = new RLMEventDashboard();
  dashboard.render({ ...rootStart, prompt: "first" });
  dashboard.render({ type: "run_end", runId: 0, depth: 0, result: "done", usage: runUsage });
  const second = dashboard.render({ ...rootStart, prompt: "second" });
  assert.match(second, /second/);
  assert.doesNotMatch(second, /first/);
  assert.equal(dashboard.isComplete(), false);
});

test("dashboard truncates every plain line to configured columns", () => {
  const dashboard = new RLMEventDashboard({ columns: 24, outputLimit: 240 });
  dashboard.render({ ...rootStart, prompt: "a very long prompt #123 that must not wrap" });
  const snapshot = dashboard.render({
    type: "run_error",
    runId: 0,
    depth: 0,
    error: "a very long error payload that must not wrap",
    usage: runUsage,
  });
  assert.ok(snapshot.split("\n").every((line) => line.length <= 24));
});

test("dashboard truncates wide graphemes without splitting them or wrapping", () => {
  const dashboard = new RLMEventDashboard({ columns: 12 });
  dashboard.render({ ...rootStart, prompt: "界界界界😀😀😀" });
  const snapshot = dashboard.snapshot();
  for (const line of snapshot.split("\n")) {
    const approximateWidth = [...line].reduce(
      (width, value) =>
        width + (/\p{Extended_Pictographic}/u.test(value) || /[界]/u.test(value) ? 2 : 1),
      0,
    );
    assert.ok(approximateWidth <= 11);
    assert.doesNotMatch(line, /\uFFFD/);
  }
});

test("TTY redraw avoids hiding the cursor", () => {
  const writes: string[] = [];
  const trace = createRLMEventTracer({
    tty: true,
    color: false,
    write: (value) => writes.push(value),
  });
  trace(rootStart);
  assert.ok(writes.every((value) => !value.includes("\u001b[?25l")));
});

test("TTY tracer redraws with ANSI cleanup and never writes after completion", () => {
  const writes: string[] = [];
  const trace = createRLMEventTracer({
    tty: true,
    color: false,
    write: (value) => writes.push(value),
    maxDepth: 3,
  });
  trace(rootStart);
  trace({
    type: "javascript_start",
    runId: 0,
    depth: 0,
    toolCallId: "tool",
    code: "throw new Error()",
  });
  trace({
    type: "javascript_end",
    runId: 0,
    depth: 0,
    toolCallId: "tool",
    output: "TypeError: boom\nSECRET",
    isError: true,
  });
  assert.match(writes.at(-1) ?? "", /JavaScript error: TypeError: boom/);
  trace({ type: "run_error", runId: 0, depth: 0, error: "failed", usage: runUsage });
  const count = writes.length;
  assert.doesNotMatch(writes.at(-1) ?? "", /\u001b\[\?25[lh]/);
  trace({ type: "model_start", runId: 0, depth: 0, modelCall: 9 });
  assert.equal(writes.length, count);
});

test("redirected tracer remains compact and append-only without ANSI", () => {
  const writes: string[] = [];
  const trace = createRLMEventTracer({ tty: false, write: (value) => writes.push(value) });
  trace(rootStart);
  trace({ type: "model_start", runId: 0, depth: 0, modelCall: 1 });
  assert.equal(writes.length, 2);
  assert.ok(writes.every((line) => !line.includes("\u001b")));
  assert.match(writes[1], /waiting for model/);
});

test("compact identity cleanup does not rewrite prompt or error payload IDs", () => {
  const writes: string[] = [];
  const trace = createRLMEventTracer({ tty: false, write: (value) => writes.push(value) });
  trace({ ...rootStart, prompt: "prompt #123" });
  trace({ type: "run_error", runId: 0, depth: 0, error: "error #456", usage: runUsage });
  assert.match(writes[0], /prompt #123/);
  assert.match(writes[1], /error #456/);
  assert.doesNotMatch(writes[0], /root#0/);
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
