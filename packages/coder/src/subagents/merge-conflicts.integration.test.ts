import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, test } from "node:test";
import { parseSubagentDefinition } from "./definitions.ts";
import { createMergeConflictsPrompt } from "./prompts/merge-conflicts.ts";
import { createMergeConflictsWorkflow } from "./workflows/merge-conflicts.ts";

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

type ConflictOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "none";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function conflictingGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0, `git ${args.join(" ")} unexpectedly succeeded`);
  assert.notEqual(git(cwd, ["ls-files", "-u"]).trim(), "");
}

function commitFile(cwd: string, content: string, message: string): string {
  writeFileSync(join(cwd, "conflict.txt"), content);
  git(cwd, ["add", "conflict.txt"]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function startConflict(cwd: string, operation: ConflictOperation): void {
  commitFile(cwd, "base\n", "base");

  if (operation === "revert") {
    const revertedCommit = commitFile(cwd, "reverted change\n", "change to revert");
    git(cwd, ["switch", "-c", "feature"]);
    commitFile(cwd, "later change\n", "later change");
    conflictingGit(cwd, ["revert", revertedCommit]);
    return;
  }

  git(cwd, ["switch", "-c", "target"]);
  const targetCommit = commitFile(cwd, "target\n", "target change");
  git(cwd, ["switch", "-c", "feature", "HEAD~1"]);
  commitFile(cwd, "feature\n", "feature change");

  if (operation === "rebase") {
    conflictingGit(cwd, ["rebase", "target"]);
  } else if (operation === "cherry-pick") {
    conflictingGit(cwd, ["cherry-pick", targetCommit]);
  } else {
    conflictingGit(cwd, ["merge", "--no-edit", "target"]);
    if (operation === "none") {
      const mergeHeadPath = git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
      unlinkSync(join(cwd, mergeHeadPath));
    }
  }
}

function withConflict(
  operation: ConflictOperation,
  run: (cwd: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "merge-conflicts-test-"));
    try {
      git(cwd, ["init", "--initial-branch", "main"]);
      git(cwd, ["config", "user.email", "test@example.com"]);
      git(cwd, ["config", "user.name", "Test User"]);
      startConflict(cwd, operation);
      await run(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

suite("merge-only conflict workflow in real repositories", () => {
  test(
    "adopts and commits an existing merge conflict",
    withConflict("merge", async (cwd) => {
      const prompt = await createMergeConflictsPrompt()({ cwd, definition });
      assert.match(prompt, /Conflicts were already present/);
      const commitsBefore = Number(
        git(cwd, ["rev-list", "--first-parent", "--count", "HEAD"]).trim(),
      );

      const workflow = createMergeConflictsWorkflow({ assertWorkspace: async () => {} });
      const result = await workflow({
        cwd,
        definition,
        prompt,
        subagent: {
          definition,
          session: {
            async prompt() {
              writeFileSync(join(cwd, "conflict.txt"), "resolved\n");
              git(cwd, ["add", "conflict.txt"]);
            },
            getLastAssistantText() {
              return "Resolved the merge conflict.";
            },
          } as never,
          dispose() {},
        },
        onProgress() {},
      });

      assert.match(result, /Resolved the merge conflict/);
      assert.equal(
        Number(git(cwd, ["rev-list", "--first-parent", "--count", "HEAD"]).trim()),
        commitsBefore + 1,
      );
      assert.notEqual(
        spawnSync("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], { cwd }).status,
        0,
      );
    }),
  );

  test(
    "fails safely when MERGE_HEAD disappears before commit",
    withConflict("merge", async (cwd) => {
      const headBefore = git(cwd, ["rev-parse", "HEAD"]);
      const mergeHeadPath = git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
      const workflow = createMergeConflictsWorkflow({ assertWorkspace: async () => {} });

      await assert.rejects(
        workflow({
          cwd,
          definition,
          prompt: "Resolve the conflict.",
          subagent: {
            definition,
            session: {
              async prompt() {
                writeFileSync(join(cwd, "conflict.txt"), "resolved\n");
                git(cwd, ["add", "conflict.txt"]);
                unlinkSync(join(cwd, mergeHeadPath));
              },
              getLastAssistantText() {
                return "Resolved the conflict.";
              },
            } as never,
            dispose() {},
          },
          onProgress() {},
        }),
        /merge ended before merge_conflicts could create the merge commit/,
      );
      assert.equal(git(cwd, ["rev-parse", "HEAD"]), headBefore);
    }),
  );

  for (const [operation, message] of [
    ["rebase", "merge_conflicts cannot continue an in-progress rebase"],
    ["cherry-pick", "merge_conflicts cannot continue an in-progress cherry-pick"],
    ["revert", "merge_conflicts cannot continue an in-progress revert"],
    ["none", "Unmerged index entries exist, but no merge is in progress"],
  ] as const) {
    test(
      `rejects an existing ${operation} conflict`,
      withConflict(operation, async (cwd) => {
        const headBefore = git(cwd, ["rev-parse", "HEAD"]);
        await assert.rejects(
          createMergeConflictsPrompt()({ cwd, definition }),
          new RegExp(message),
        );
        assert.equal(git(cwd, ["rev-parse", "HEAD"]), headBefore);
      }),
    );
  }
});

test("keeps the merge-conflicts integration definition available", () => {
  assert.equal(definition.name, "merge_conflicts");
});

test("keeps the merge-conflicts prompt available to integration tests", () => {
  assert.equal(typeof createMergeConflictsPrompt, "function");
});
