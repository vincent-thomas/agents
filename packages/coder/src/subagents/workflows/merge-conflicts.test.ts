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
    "Conflicts remain; resuming the conflict resolver…",
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

test("continues an ordinary rebase noninteractively through repeated conflicts", async () => {
  const prompts: string[] = [];
  const progress: string[] = [];
  const unmergedEntries = ["", "100644 next 2\tnext.ts\n", "", ""];
  const continuations = [
    { success: false, output: "Conflict in the next rebased commit" },
    { success: true, output: "Rebase completed" },
  ];
  let rebaseActive = true;
  let continueCalls = 0;
  let workspaceAssertions = 0;

  const workflow = createMergeConflictsWorkflow({
    async assertWorkspace() {
      workspaceAssertions += 1;
    },
    pathExists(path) {
      return rebaseActive && path.endsWith("rebase-merge");
    },
    commandOutput: async (command, args) => {
      assert.equal(command, "git");
      if (args[0] === "ls-files") return unmergedEntries.shift()!;
      if (args[1] === "--verify") throw new Error("missing");
      assert.equal(args[1], "--git-path");
      return `.git/${args[2]}\n`;
    },
    async continueRebase() {
      continueCalls += 1;
      const result = continuations.shift()!;
      if (result.success) rebaseActive = false;
      return result;
    },
    async commit() {
      throw new Error("ordinary rebases must not create merge commits");
    },
  });

  const result = await workflow({
    cwd: "/repo",
    definition,
    prompt: "initial rebase conflict prompt",
    subagent: {
      definition,
      session: {
        async prompt(prompt: string) {
          prompts.push(prompt);
        },
        getLastAssistantText() {
          return "Resolved ordinary rebase conflicts.";
        },
      } as never,
      dispose() {},
    },
    onProgress(text) {
      progress.push(text);
    },
  });

  assert.equal(continueCalls, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /another conflicted commit/);
  assert.match(prompts[1]!, /next\.ts/);
  assert.deepEqual(progress, [
    "Continuing the in-progress rebase…",
    "The rebase reached another conflict; resuming the resolver…",
    "Continuing the in-progress rebase…",
  ]);
  assert.equal(workspaceAssertions, 1);
  assert.match(result, /Resolved ordinary rebase conflicts/);
  assert.match(result, /Rebase completed/);
});

test("skips an empty ordinary rebase replay only after Git requests it", async () => {
  const commands: string[] = [];
  let rebaseActive = true;
  let skipCalls = 0;
  const workflow = createMergeConflictsWorkflow({
    async assertWorkspace() {},
    pathExists(path) {
      return rebaseActive && path.endsWith("rebase-merge");
    },
    commandOutput: async (command, args) => {
      commands.push(`${command} ${args.join(" ")}`);
      if (args[0] === "ls-files") return "";
      if (args[0] === "rebase" && args[1] === "--skip") {
        skipCalls += 1;
        rebaseActive = false;
        return "Skipped empty commit";
      }
      if (args[1] === "--verify") throw new Error("missing");
      assert.equal(args[1], "--git-path");
      return `.git/${args[2]}\n`;
    },
    async continueRebase() {
      return {
        success: false,
        output:
          "The previous cherry-pick is now empty, possibly due to conflict resolution.\n" +
          "Otherwise, please use 'git rebase --skip'",
      };
    },
  });

  const result = await workflow({
    cwd: "/repo",
    definition,
    prompt: "initial rebase conflict prompt",
    subagent: {
      definition,
      session: {
        async prompt() {},
        getLastAssistantText() {
          return "Resolved empty ordinary replay.";
        },
      } as never,
      dispose() {},
    },
    onProgress() {},
  });

  assert.equal(skipCalls, 1);
  assert.ok(commands.includes("git rebase --skip"));
  assert.match(result, /Skipped empty commit/);
});

test("preserves a non-empty ordinary rebase continuation failure", async () => {
  let skipCalls = 0;
  const workflow = createMergeConflictsWorkflow({
    async assertWorkspace() {},
    pathExists(path) {
      return path.endsWith("rebase-merge");
    },
    commandOutput: async (command, args) => {
      assert.equal(command, "git");
      if (args[0] === "ls-files") return "";
      if (args[1] === "--verify") throw new Error("missing");
      assert.equal(args[1], "--git-path");
      return `.git/${args[2]}\n`;
    },
    async continueRebase() {
      return { success: false, output: "fatal: could not apply the resolved commit" };
    },
    async skipRebase() {
      skipCalls += 1;
      return { success: true, output: "unexpected skip" };
    },
  });

  await assert.rejects(
    workflow({
      cwd: "/repo",
      definition,
      prompt: "initial rebase conflict prompt",
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
    /git rebase --continue failed without producing conflicts:[\s\S]*could not apply/,
  );
  assert.equal(skipCalls, 0);
});

test("continues a cascading GitHub stack rebase through every conflicted branch", async () => {
  const prompts: string[] = [];
  const progress: string[] = [];
  const unmergedEntries = ["", "100644 next 2\tnext.ts\n", "", ""];
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
          return "Resolved all stack conflicts.";
        },
      } as never,
      dispose() {},
    },
    onProgress(text) {
      progress.push(text);
    },
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /another conflicted branch/);
  assert.match(prompts[1]!, /next\.ts/);
  assert.deepEqual(progress, [
    "Continuing the cascading GitHub stack rebase…",
    "The stack rebase reached another conflict; resuming the resolver…",
    "Continuing the cascading GitHub stack rebase…",
  ]);
  assert.equal(workspaceAssertions, 1);
  assert.deepEqual(restoredBranches, ["feature"]);
  assert.match(result, /Resolved all stack conflicts/);
  assert.match(result, /All branches in stack rebased/);
});
