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
  let mergeStateChecks = 0;

  const workflow = createMergeConflictsWorkflow({
    assertWorkspace: async () => {},
    commandOutput: async (command, args) => {
      assert.equal(command, "git");
      if (args[0] === "ls-files") {
        assert.deepEqual(args, ["ls-files", "-u"]);
        return unmergedEntries.shift()!;
      }
      assert.deepEqual(args, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
      mergeStateChecks += 1;
      if (mergeStateChecks === 3) throw new Error("merge completed");
      return "merge-head\n";
    },
    commit: async (options) => {
      commitOptions.push({ message: options.message, addAll: options.addAll });
      return commitResults.shift()!;
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
    commandOutput: async (command, args) => {
      assert.equal(command, "git");
      if (args[0] === "ls-files") return "";
      assert.deepEqual(args, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
      throw new Error("missing");
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
