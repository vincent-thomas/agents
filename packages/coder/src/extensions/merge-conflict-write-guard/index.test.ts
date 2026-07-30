import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitOperation } from "../../git-operation.ts";
import { mergeConflictWriteBlockReason, mergeConflictWriteGuardExtension } from "./index.ts";

type ToolCallHandler = (event: unknown, context: unknown) => Promise<unknown>;

function setup(stdout: string, code = 0, operation: GitOperation = "merge") {
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
      const gitArgs = args[1] as string[];
      if (gitArgs[0] === "ls-files") return { stdout, stderr: "", code, killed: false };
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--verify") {
        const expectedRef =
          operation === "merge"
            ? "MERGE_HEAD"
            : operation === "cherry-pick"
              ? "CHERRY_PICK_HEAD"
              : operation === "revert"
                ? "REVERT_HEAD"
                : undefined;
        const found = gitArgs[3] === expectedRef;
        return { stdout: found ? "head\n" : "", stderr: "", code: found ? 0 : 1, killed: false };
      }
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--git-path") {
        return { stdout: `/missing/${gitArgs[2]}\n`, stderr: "", code: 0, killed: false };
      }
      throw new Error(`Unexpected Git arguments: ${gitArgs.join(" ")}`);
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
    reason: "Unresolved merge conflicts are present. Use merge_conflicts before calling write.",
  });
  assert.deepEqual(guard.execCalls, [
    ["git", ["ls-files", "-u"], { cwd: "/repo", signal: undefined, timeout: 5_000 }],
    [
      "git",
      ["rev-parse", "--verify", "-q", "MERGE_HEAD"],
      { cwd: "/repo", signal: undefined, timeout: 5_000 },
    ],
  ]);
  assert.deepEqual(guard.notifications, [
    [
      "Unresolved merge conflicts are present. Use merge_conflicts before calling write.",
      "warning",
    ],
  ]);
});

test("reports the active non-merge operation", async () => {
  const guard = setup("100644 abc 2\tsrc/index.ts\n", 0, "cherry-pick");

  const result = await guard.invoke({
    toolName: "write",
    toolCallId: "write-1",
    input: { path: "src/index.ts", content: "replacement" },
  });

  assert.deepEqual(result, {
    block: true,
    reason:
      "A cherry-pick conflict is in progress; resolve it outside this merge-only workflow before calling write.",
  });
});

test("provides operation-specific block reasons", () => {
  assert.match(mergeConflictWriteBlockReason("rebase"), /rebase conflict.*merge-only workflow/);
  assert.match(mergeConflictWriteBlockReason("revert"), /revert conflict.*merge-only workflow/);
  assert.match(mergeConflictWriteBlockReason("none"), /without a recognized Git operation/);
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
