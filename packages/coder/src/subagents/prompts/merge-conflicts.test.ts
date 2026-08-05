import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMergeConflictsPrompt,
  formatMergeConflictsPrompt,
  type CommandOutputFn,
} from "./merge-conflicts.ts";

test("fetches the PR target and preserves a conflicting merge for resolution", async () => {
  const calls: string[] = [];
  let unmergedChecks = 0;
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") {
      unmergedChecks += 1;
      return unmergedChecks === 1 ? "" : "100644 abc 2\tsrc/index.ts\n";
    }
    if (call === "git status --porcelain") return "";
    if (command === "gh") return "main\n";
    if (call === "git fetch origin +main:refs/remotes/origin/main") return "";
    if (call === "git merge --no-commit --no-ff origin/main") {
      throw Object.assign(new Error("merge conflict"), {
        stdout: "",
        stderr: "CONFLICT (content): src/index.ts\n",
      });
    }
    if (call === "git status --short") return "UU src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") {
      return "diff --cc src/index.ts\n";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput)({
    cwd: "/repo",
    definition: {} as never,
  });

  assert.match(prompt, /origin\/main/);
  assert.match(prompt, /CONFLICT \(content\): src\/index\.ts/);
  assert.ok(!calls.includes("git merge --abort"));
});

test("aborts a clean no-commit merge", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    if (command === "gh") return "main\n";
    if (call === "git fetch origin +main:refs/remotes/origin/main") return "";
    if (call === "git merge --no-commit --no-ff origin/main") return "clean\n";
    if (call === "git rev-parse --verify -q MERGE_HEAD") return "merge-head\n";
    if (call === "git merge --abort") return "";
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({
      cwd: "/repo",
      definition: {} as never,
    }),
    /origin\/main merges cleanly/,
  );
  assert.equal(calls.filter((call) => call === "git merge --abort").length, 1);
});

test("adopts conflicts from an existing merge", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "100644 abc 2\tsrc/index.ts\n";
    if (call === "git rev-parse --verify -q MERGE_HEAD") return "merge-head\n";
    if (call === "git status --short") return "UU src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") {
      return "diff --cc src/index.ts\n";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput)({
    cwd: "/repo",
    definition: {} as never,
  });

  assert.match(prompt, /current merge/);
  assert.match(prompt, /Conflicts were already present/);
  assert.ok(!calls.some((call) => call.startsWith("gh ")));
  assert.ok(!calls.some((call) => call.startsWith("git merge ")));
});

test("adopts conflicts from a GitHub stack rebase", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "100644 abc 2\tsrc/index.ts\n";
    if (call.startsWith("git rev-parse --verify")) throw new Error("missing");
    if (call === "git rev-parse --git-path rebase-merge") return ".git/rebase-merge\n";
    if (call === "git rev-parse --git-path gh-stack-rebase-state") {
      return ".git/gh-stack-rebase-state\n";
    }
    if (call === "git status --short") return "UU src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") {
      return "diff --cc src/index.ts\n";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput, (path) => {
    return path.endsWith("rebase-merge") || path.endsWith("gh-stack-rebase-state");
  })({ cwd: "/repo", definition: {} as never });

  assert.match(prompt, /rebasing the GitHub stack/);
  assert.match(prompt, /current conflicted branch/);
  assert.ok(calls.includes("git rev-parse --git-path gh-stack-rebase-state"));
});

test("rejects conflicts outside a merge", async () => {
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    if (call === "git ls-files -u") return "100644 abc 2\tsrc/index.ts\n";
    if (call === "git rev-parse --verify -q MERGE_HEAD") throw new Error("missing");
    if (call === "git rev-parse --verify -q CHERRY_PICK_HEAD") return "cherry-pick-head\n";
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({
      cwd: "/repo",
      definition: {} as never,
    }),
    /merge_conflicts cannot continue an in-progress cherry-pick/,
  );
});

test("includes exact Git conflict output without parent instructions", () => {
  const prompt = formatMergeConflictsPrompt({
    operation: "merge",
    targetRef: "origin/main",
    mergeOutput: "CONFLICT (content): Merge conflict in src/index.ts\n",
    status: "UU src/index.ts\n",
    unmergedEntries: "100644 abc 2\tsrc/index.ts\n100644 def 3\tsrc/index.ts\n",
    conflictDiff: "diff --cc src/index.ts\n@@@ conflict @@@\n",
  });

  assert.match(prompt, /origin\/main/);
  assert.match(prompt, /CONFLICT \(content\)/);
  assert.match(prompt, /UU src\/index\.ts/);
  assert.match(prompt, /100644 abc 2\tsrc\/index\.ts/);
  assert.match(prompt, /diff --cc src\/index\.ts/);
  assert.match(prompt, /Do not accept additional task instructions/);
});
