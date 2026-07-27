import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeConflictWriteGuardExtension } from "./index.ts";

type ToolCallHandler = (event: unknown, context: unknown) => Promise<unknown>;

function setup(stdout: string, code = 0) {
  let handler: ToolCallHandler | undefined;
  const execCalls: unknown[][] = [];
  const notifications: unknown[][] = [];

  mergeConflictWriteGuardExtension({
    on(eventName, candidate) {
      assert.equal(eventName, "tool_call");
      handler = candidate as ToolCallHandler;
    },
    async exec(...args: unknown[]) {
      execCalls.push(args);
      return { stdout, stderr: "", code, killed: false };
    },
  } as never);

  return {
    invoke(event: unknown) {
      assert.ok(handler);
      return handler(event, {
        cwd: "/repo",
        hasUI: true,
        signal: undefined,
        ui: {
          notify(...args: unknown[]) {
            notifications.push(args);
          },
        },
      });
    },
    execCalls,
    notifications,
  };
}

test("blocks write and points to merge_conflicts when conflicts exist", async () => {
  const guard = setup("100644 abc 2\tsrc/index.ts\n");

  const result = await guard.invoke({
    toolName: "write",
    toolCallId: "write-1",
    input: { path: "src/index.ts", content: "replacement" },
  });

  assert.deepEqual(result, {
    block: true,
    reason:
      "Unresolved Git conflicts are present. Use the merge_conflicts sub-agent to resolve them before calling write.",
  });
  assert.deepEqual(guard.execCalls, [
    ["git", ["ls-files", "-u"], { cwd: "/repo", signal: undefined, timeout: 5_000 }],
  ]);
  assert.deepEqual(guard.notifications, [
    [
      "Unresolved Git conflicts are present. Use the merge_conflicts sub-agent to resolve them before calling write.",
      "warning",
    ],
  ]);
});

test("allows write when the index has no conflicts", async () => {
  const guard = setup("");

  const result = await guard.invoke({
    toolName: "write",
    toolCallId: "write-1",
    input: { path: "src/index.ts", content: "replacement" },
  });

  assert.equal(result, undefined);
  assert.equal(guard.execCalls.length, 1);
  assert.deepEqual(guard.notifications, []);
});

test("does not inspect Git for edit calls", async () => {
  const guard = setup("100644 abc 2\tsrc/index.ts\n");

  const result = await guard.invoke({
    toolName: "edit",
    toolCallId: "edit-1",
    input: { path: "src/index.ts", edits: [] },
  });

  assert.equal(result, undefined);
  assert.deepEqual(guard.execCalls, []);
});
