import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubagentDefinition } from "../definitions.ts";
import { createMergeConflictsWorkflow, parseStackRebaseOriginalBranch } from "./merge-conflicts.ts";

const definition = parseSubagentDefinition(
  `---
name: merge_conflicts
label: Merge Conflicts
description: Resolve conflicts
model: example/model
thinking: low
prompt: merge_conflicts
tools: read, edit
---

Resolve every conflict.
`,
  "merge-conflicts.md",
);

test("resumes until conflicts are gone and the required commit succeeds", async () => {
  const prompts: string[] = [];
  const progress: string[] = [];
  const unmergedEntries = ["100644 a.ts\n", "", ""];
  const commitResults = [
    { success: false, output: "Pre-commit check failed: tests failed" },
    { success: true, output: "Merge committed" },
  ];
  const commitOptions: Array<{ message?: string; addAll: boolean }> = [];
  let assistantText = "";
  let mergeActive = true;

  const workflow = createMergeConflictsWorkflow({
    assertWorkspace: async () => {},
    pathExists: () => false,
    commandOutput: async (command, args) => {
      assert.equal(command, "git");
      if (args[0] === "ls-files") {
        assert.deepEqual(args, ["ls-files", "-u"]);
        return unmergedEntries.shift()!;
      }
      if (args[1] === "--verify") {
        if (args[3] === "MERGE_HEAD" && mergeActive) return "merge-head\n";
        throw new Error("missing");
      }
      assert.equal(args[1], "--git-path");
      return `.git/${args[2]}\n`;
    },
    commit: async (options) => {
      commitOptions.push({ message: options.message, addAll: options.addAll });
      const result = commitResults.shift()!;
      if (result.success) mergeActive = false;
      return result;
    },
  });

  const result = await workflow({
    cwd: "/repo",
    definition,
    prompt: "initial conflict prompt",
    subagent: {
      definition,
      session: {
        async prompt(prompt: string) {
          prompts.push(prompt);
          assistantText = `resolver report ${prompts.length}`;
        },
        getLastAssistantText() {
          return assistantText;
        },
      } as never,
      dispose() {},
    },
    onProgress(text) {
      progress.push(text);
    },
  });

  assert.equal(prompts.length, 3);
  assert.match(prompts[1]!, /Remaining unmerged index entries:\n100644 a\.ts/);
  assert.match(prompts[2]!, /Pre-commit check failed: tests failed/);
  assert.deepEqual(commitOptions, [
    { message: undefined, addAll: false },
    { message: undefined, addAll: false },
  ]);
  assert.deepEqual(progress, [
    "Conflicts remain; resuming the merge resolver…",
    "Required checks or commit failed; resuming the merge resolver…",
  ]);
  assert.equal(result, "resolver report 3\n\nMerge committed");
});

test("fails safely when MERGE_HEAD disappears before commit", async () => {
  let commitCalled = false;
  const workflow = createMergeConflictsWorkflow({
    assertWorkspace: async () => {},
    pathExists: () => false,
    commandOutput: async (command, args) => {
      assert.equal(command, "git");
      if (args[0] === "ls-files") return "";
      if (args[1] === "--verify") throw new Error("missing");
      assert.equal(args[1], "--git-path");
      return `.git/${args[2]}\n`;
    },
    commit: async () => {
      commitCalled = true;
      return { success: true, output: "unexpected commit" };
    },
  });

  await assert.rejects(
    workflow({
      cwd: "/repo",
      definition,
      prompt: "initial conflict prompt",
      subagent: {
        definition,
        session: {
          async prompt() {},
          getLastAssistantText() {
            return "resolver report";
          },
        } as never,
        dispose() {},
      },
      onProgress() {},
    }),
    /merge ended before merge_conflicts could create the merge commit/,
  );
  assert.equal(commitCalled, false);
});

test("reads the original branch from gh-stack rebase state formats", () => {
  assert.equal(parseStackRebaseOriginalBranch('{"originalBranch":"feature"}'), "feature");
  assert.equal(parseStackRebaseOriginalBranch('{"original_branch":"feature"}'), "feature");
  assert.equal(parseStackRebaseOriginalBranch("{}"), null);
  assert.equal(parseStackRebaseOriginalBranch("invalid"), null);
});

test("continues a cascading GitHub stack rebase through every conflicted branch", async () => {
  const prompts: string[] = [];
  const progress: string[] = [];
  const unmergedEntries = ["100644 bottom 2\tbottom.ts\n", "", "100644 next 2\tnext.ts\n", "", ""];
  const continuations = [
    { success: false, output: "Conflict detected rebasing middle onto bottom" },
    { success: true, output: "All branches in stack rebased" },
  ];
  let rebaseActive = true;
  let workspaceAssertions = 0;
  const restoredBranches: string[] = [];

  const workflow = createMergeConflictsWorkflow({
    async assertWorkspace() {
      workspaceAssertions += 1;
    },
    pathExists(path) {
      return (
        rebaseActive && (path.endsWith("rebase-merge") || path.endsWith("gh-stack-rebase-state"))
      );
    },
    commandOutput: async (command, args) => {
      assert.equal(command, "git");
      if (args[0] === "ls-files") return unmergedEntries.shift()!;
      if (args[1] === "--verify") throw new Error("missing");
      assert.equal(args[1], "--git-path");
      return `.git/${args[2]}\n`;
    },
    async readStackRebaseOriginalBranch() {
      return "feature";
    },
    async continueStackRebase() {
      const result = continuations.shift()!;
      if (result.success) rebaseActive = false;
      return result;
    },
    async restoreBranch(_cwd, branch) {
      restoredBranches.push(branch);
      return { success: true, output: "restored" };
    },
    async commit() {
      throw new Error("stack rebases must not create merge commits");
    },
  });

  const result = await workflow({
    cwd: "/repo",
    definition,
    prompt: "initial stack conflict prompt",
    subagent: {
      definition,
      session: {
        async prompt(prompt: string) {
          prompts.push(prompt);
        },
        getLastAssistantText() {
          return prompts.length <= 2 ? "Resolved bottom.ts." : "Resolved next.ts.";
        },
      } as never,
      dispose() {},
    },
    onProgress(text) {
      progress.push(text);
    },
  });

  assert.equal(prompts.length, 3);
  assert.match(prompts[1]!, /stopped before resolving every conflict/);
  assert.match(prompts[1]!, /bottom\.ts/);
  assert.match(prompts[2]!, /another conflicted branch/);
  assert.match(prompts[2]!, /next\.ts/);
  assert.deepEqual(progress, [
    "Conflicts remain; resuming the merge resolver…",
    "Continuing the cascading GitHub stack rebase…",
    "The stack rebase reached another conflict; resuming the resolver…",
    "Continuing the cascading GitHub stack rebase…",
  ]);
  assert.equal(workspaceAssertions, 1);
  assert.deepEqual(restoredBranches, ["feature"]);
  assert.equal(
    result,
    [
      "Stack conflict 1:\nResolved bottom.ts.",
      "Stack conflict 2:\nResolved next.ts.",
      "All branches in stack rebased",
    ].join("\n\n"),
  );
});

test("restores the owned branch when cancellation arrives as stack continuation finishes", async () => {
  const controller = new AbortController();
  let rebaseActive = true;
  let restored = false;

  const workflow = createMergeConflictsWorkflow({
    assertWorkspace: async () => {},
    pathExists(path) {
      return (
        rebaseActive && (path.endsWith("rebase-merge") || path.endsWith("gh-stack-rebase-state"))
      );
    },
    commandOutput: async (command, args, _cwd, signal) => {
      assert.equal(command, "git");
      if (controller.signal.aborted) assert.equal(signal, undefined);
      if (args[0] === "ls-files") return "";
      if (args[1] === "--verify") throw new Error("missing");
      assert.equal(args[1], "--git-path");
      return `.git/${args[2]}\n`;
    },
    async readStackRebaseOriginalBranch() {
      return "feature";
    },
    async continueStackRebase() {
      rebaseActive = false;
      controller.abort();
      return { success: true, output: "All branches in stack rebased" };
    },
    async restoreBranch(_cwd, branch, signal) {
      assert.equal(branch, "feature");
      assert.equal(signal, undefined);
      restored = true;
      return { success: true, output: "restored" };
    },
  });

  await workflow({
    cwd: "/repo",
    definition,
    prompt: "initial stack conflict prompt",
    signal: controller.signal,
    subagent: {
      definition,
      session: {
        async prompt() {},
        getLastAssistantText() {
          return "Resolved the stack conflict.";
        },
      } as never,
      dispose() {},
    },
    onProgress() {},
  });

  assert.equal(restored, true);
});
