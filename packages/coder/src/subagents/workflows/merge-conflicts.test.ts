import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubagentDefinition } from "../definitions.ts";
import { createMergeConflictsWorkflow } from "./merge-conflicts.ts";

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
    async continueStackRebase() {
      const result = continuations.shift()!;
      if (result.success) rebaseActive = false;
      return result;
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
  assert.match(result, /Resolved all stack conflicts/);
  assert.match(result, /All branches in stack rebased/);
});
