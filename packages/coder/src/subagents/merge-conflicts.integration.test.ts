import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { suite, test } from "node:test";
import { createFixCiExtension } from "../../../fix-ci/index.ts";
import type { GhStackCommandRunner } from "../../../fix-ci/github-stack.ts";
import type { StackReadinessRunner } from "../../../fix-ci/stack-readiness.ts";
import { parseSubagentDefinition } from "./definitions.ts";
import { createMergeConflictsPrompt, type CommandOutputFn } from "./prompts/merge-conflicts.ts";
import { createMergeConflictsWorkflow } from "./workflows/merge-conflicts.ts";

const execFileAsync = promisify(execFile);

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

test("resolves cascading real GitHub stack rebase conflicts through push_and_check_ci", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "merge-conflicts-stack-test-"));
  const origin = mkdtempSync(join(tmpdir(), "merge-conflicts-stack-origin-"));
  try {
    git(cwd, ["init", "--initial-branch", "main"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "user.name", "Test User"]);
    git(cwd, ["config", "core.editor", "true"]);
    writeFileSync(join(cwd, "lower.txt"), "lower base\n");
    writeFileSync(join(cwd, "tip.txt"), "tip base\n");
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-m", "base"]);

    git(cwd, ["switch", "-c", "lower"]);
    writeFileSync(join(cwd, "lower.txt"), "lower branch\n");
    git(cwd, ["add", "lower.txt"]);
    git(cwd, ["commit", "-m", "lower change"]);
    git(cwd, ["switch", "-c", "tip"]);
    writeFileSync(join(cwd, "tip.txt"), "tip branch\n");
    git(cwd, ["add", "tip.txt"]);
    git(cwd, ["commit", "-m", "tip change"]);

    git(cwd, ["switch", "main"]);
    writeFileSync(join(cwd, "lower.txt"), "updated lower\n");
    writeFileSync(join(cwd, "tip.txt"), "updated tip\n");
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-m", "update main"]);
    git(cwd, ["switch", "tip"]);

    git(origin, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", origin]);
    git(cwd, ["push", "origin", "main", "lower", "tip"]);
    const originalLower = git(cwd, ["rev-parse", "lower"]).trim();

    let syncAttempts = 0;
    let submitCalls = 0;
    const stackCalls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      stackCalls.push(args.join(" "));
      assert.equal(args[0], "stack");
      if (args[1] === "view") {
        return {
          stdout: '{"branches":[{"branch":"lower"},{"branch":"tip"}]}',
          stderr: "",
        };
      }
      if (args[1] === "sync") {
        syncAttempts += 1;
        if (syncAttempts === 1) {
          // Real gh stack sync restores every branch when the first rebase
          // conflicts, so no prepared operation remains for the resolver.
          git(cwd, ["switch", "lower"]);
          git(cwd, ["switch", "tip"]);
          throw Object.assign(new Error("stack sync restored after conflict"), {
            stdout: "Conflict detected rebasing lower onto main\n",
            stderr: "All branches restored to their original state.\n",
          });
        }
        return { stdout: "stack synced", stderr: "" };
      }
      assert.equal(args[1], "submit");
      submitCalls += 1;
      return { stdout: "stack submitted", stderr: "" };
    };

    const readinessRunner: StackReadinessRunner = async (_cwd, branches) => ({
      allChecksPassed: true,
      allReady: true,
      branches: branches.map((branch, index) => ({
        branch,
        sha: git(cwd, ["rev-parse", branch]).trim(),
        prNumber: index + 1,
        prState: "OPEN",
        prHeadRefOid: git(cwd, ["rev-parse", branch]).trim(),
        isDraft: true,
        checks: [],
        timedOut: false,
        polls: 0,
        mode: "integration test",
        failureLogs: [],
        ready: true,
      })),
    });

    type FixCiTool = {
      name: string;
      execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        context: { cwd: string },
      ): Promise<{ details: Record<string, unknown> }>;
    };
    const tools: FixCiTool[] = [];
    createFixCiExtension({
      assertWorkspace: async (workspace) => {
        assert.equal(git(workspace, ["branch", "--show-current"]).trim(), "tip");
        assert.equal(git(workspace, ["status", "--porcelain"]).trim(), "");
      },
      stackRunner,
      stackReadinessRunner: readinessRunner,
    })({
      registerTool(tool: FixCiTool) {
        tools.push(tool);
      },
    } as never);
    const pushAndCheck = tools.find((tool) => tool.name === "push_and_check_ci");
    assert.ok(pushAndCheck, "push_and_check_ci was not registered");

    const firstPush = await pushAndCheck.execute("first-push", {}, undefined, undefined, { cwd });
    assert.equal(firstPush.details.stackSyncConflict, undefined);
    assert.equal(firstPush.details.stackSyncFailed, true);
    assert.equal(firstPush.details.stackReadiness, undefined);
    assert.equal(git(cwd, ["ls-files", "-u"]).trim(), "");
    assert.equal(git(cwd, ["branch", "--show-current"]).trim(), "tip");

    const promptStackCalls: string[] = [];
    const commandOutput: CommandOutputFn = async (command, args, workspace, signal) => {
      const call = `${command} ${args.join(" ")}`;
      if (command === "gh") {
        promptStackCalls.push(call);
        if (call === "gh stack view --json") {
          return '{"branches":[{"branch":"lower"},{"branch":"tip"}]}';
        }
        if (call === "gh stack rebase") {
          git(workspace, ["switch", "lower"]);
          const rebase = spawnSync("git", ["rebase", "main"], {
            cwd: workspace,
            encoding: "utf8",
          });
          assert.notEqual(rebase.status, 0, "the lower branch rebase should conflict");
          const statePath = git(workspace, [
            "rev-parse",
            "--git-path",
            "gh-stack-rebase-state",
          ]).trim();
          writeFileSync(
            join(workspace, statePath),
            JSON.stringify({ originalBranch: "tip" }) + "\n",
          );
          throw Object.assign(new Error("lower stack rebase stopped on a conflict"), {
            stdout: rebase.stdout,
            stderr: rebase.stderr,
          });
        }
      }
      const result = await execFileAsync(command, args, {
        cwd: workspace,
        signal,
        encoding: "utf8",
      });
      return String(result.stdout);
    };
    const statePath = git(cwd, ["rev-parse", "--git-path", "gh-stack-rebase-state"]).trim();
    const prompt = await createMergeConflictsPrompt(commandOutput)({ cwd, definition });
    assert.deepEqual(promptStackCalls, ["gh stack view --json", "gh stack rebase"]);
    assert.notEqual(git(cwd, ["ls-files", "-u"]).trim(), "");
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, statePath), "utf8")), {
      originalBranch: "tip",
    });
    const resolvedPaths: string[] = [];
    let assistantReport = "";
    let continuationCalls = 0;
    const workflow = createMergeConflictsWorkflow({
      assertWorkspace: async () => {
        assert.equal(git(cwd, ["branch", "--show-current"]).trim(), "tip");
        assert.equal(git(cwd, ["status", "--porcelain"]).trim(), "");
      },
      continueStackRebase: async (workspace) => {
        continuationCalls += 1;
        const continued = spawnSync("git", ["rebase", "--continue"], {
          cwd: workspace,
          encoding: "utf8",
          env: { ...process.env, GIT_EDITOR: "true" },
        });
        assert.equal(
          continued.status,
          0,
          `git rebase --continue failed:\n${continued.stdout}${continued.stderr}`,
        );
        if (continuationCalls === 1) {
          assert.equal(git(workspace, ["branch", "--show-current"]).trim(), "lower");
          git(workspace, ["switch", "tip"]);
          const tipRebase = spawnSync("git", ["rebase", "--onto", "lower", originalLower, "tip"], {
            cwd: workspace,
            encoding: "utf8",
          });
          assert.notEqual(tipRebase.status, 0, "the tip branch rebase should conflict");
          assert.notEqual(git(workspace, ["ls-files", "-u"]).trim(), "");
          return {
            success: false,
            output: `${tipRebase.stdout}${tipRebase.stderr}`,
          };
        }
        assert.equal(git(workspace, ["branch", "--show-current"]).trim(), "tip");
        unlinkSync(join(workspace, statePath));
        // Exercise the workflow's owned-branch restoration after the stack
        // command has finished traversing the branches.
        git(workspace, ["switch", "lower"]);
        return { success: true, output: "stack rebase completed" };
      },
    });

    const workflowResult = await workflow({
      cwd,
      definition,
      prompt,
      subagent: {
        definition,
        session: {
          async prompt(currentPrompt: string) {
            const entries = git(cwd, ["ls-files", "-u"]).trim().split("\n").filter(Boolean);
            const paths = [...new Set(entries.map((entry) => entry.split("\t")[1]))];
            assert.equal(paths.length, 1);
            const path = paths[0]!;
            assert.match(currentPrompt, new RegExp(path.replace(".", "\\.")));
            resolvedPaths.push(path);
            writeFileSync(join(cwd, path), `resolved ${path}\n`);
            git(cwd, ["add", path]);
            assistantReport = `Resolved ${path}.`;
          },
          getLastAssistantText() {
            return assistantReport;
          },
        } as never,
        dispose() {},
      },
      onProgress() {},
    });

    assert.deepEqual(resolvedPaths, ["lower.txt", "tip.txt"]);
    assert.equal(continuationCalls, 2);
    assert.match(workflowResult, /Stack conflict 1:\nResolved lower\.txt\./);
    assert.match(workflowResult, /Stack conflict 2:\nResolved tip\.txt\./);
    assert.match(workflowResult, /stack rebase completed/);
    assert.equal(git(cwd, ["branch", "--show-current"]).trim(), "tip");
    assert.equal(git(cwd, ["status", "--porcelain"]).trim(), "");
    assert.equal(existsSync(join(cwd, statePath)), false);
    git(cwd, ["merge-base", "--is-ancestor", "main", "lower"]);
    git(cwd, ["merge-base", "--is-ancestor", "lower", "tip"]);

    const secondPush = await pushAndCheck.execute("second-push", {}, undefined, undefined, { cwd });
    assert.equal(secondPush.details.stackReadiness, true);
    assert.equal(secondPush.details.allChecksPassed, true);
    assert.equal(secondPush.details.allReady, true);
    assert.equal(syncAttempts, 2);
    assert.equal(submitCalls, 1);
    assert.deepEqual(stackCalls, [
      "stack view --json",
      "stack sync",
      "stack view --json",
      "stack sync",
      "stack submit --auto",
    ]);
    assert.deepEqual(
      (secondPush.details.branches as Array<{ branch: string }>).map(({ branch }) => branch),
      ["lower", "tip"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});
