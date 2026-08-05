import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixCiExtension } from "./index.ts";
import type { GhStackCommandRunner, WorkspaceBranchRestorer } from "./github-stack.ts";

type RegisteredTool = {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string },
  ): Promise<{ details: Record<string, unknown> }>;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "github-stack-extension-"));
  git(cwd, ["init", "--initial-branch", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  writeFileSync(join(cwd, "file.txt"), "base\n");
  git(cwd, ["add", "file.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["switch", "-c", "feature"]);
  return cwd;
}

function registeredTools(options: {
  stackRunner: GhStackCommandRunner;
  restoreBranch?: WorkspaceBranchRestorer;
}): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const extension = createFixCiExtension({
    assertWorkspace: async () => {},
    stackRunner: options.stackRunner,
    restoreBranch: options.restoreBranch,
  });
  extension({
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as never);
  return tools;
}

function requireTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test("create_github_stack materializes branch points without switching checkout", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature one\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature one"]);
    writeFileSync(join(cwd, "file.txt"), "feature two\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature two"]);
    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
      assert.equal(
        git(cwd, ["rev-parse", "refs/heads/stack-first"]),
        git(cwd, ["rev-parse", "HEAD~1"]),
      );
      assert.equal(git(cwd, ["rev-parse", "refs/heads/feature"]), git(cwd, ["rev-parse", "HEAD"]));
      return { stdout: "Stack initialized\\n", stderr: "" };
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");

    const result = await tool.execute(
      "create-stack-with-points",
      { branches: ["stack-first", "feature"], branch_points: ["HEAD~1", "HEAD"] },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackCreated, true, JSON.stringify(result.details));
    assert.deepEqual(result.details.materializedBranches, ["stack-first"]);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.deepEqual(calls, ["stack init -- stack-first feature"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack restores the owned branch after cancellation", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature one\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature one"]);
    writeFileSync(join(cwd, "file.txt"), "feature two\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature two"]);
    const controller = new AbortController();
    const stackRunner: GhStackCommandRunner = async () => {
      git(cwd, ["switch", "stack-first"]);
      controller.abort();
      throw new Error("cancelled");
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");

    const result = await tool.execute(
      "cancel-stack",
      { branches: ["stack-first", "feature"], branch_points: ["HEAD~1", "HEAD"] },
      controller.signal,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackCreationFailed, true);
    assert.equal(result.details.workspaceRestored, true);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.equal(git(cwd, ["rev-parse", "stack-first"]), git(cwd, ["rev-parse", "HEAD~1"]));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack rolls back materialized refs before rejecting without stack init", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature one\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature one"]);
    writeFileSync(join(cwd, "file.txt"), "feature two\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature two"]);
    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      return { stdout: "should not run", stderr: "" };
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");

    const result = await tool.execute(
      "reject-stack-with-points",
      {
        branches: ["stack-base", "stack-base/nested", "feature"],
        branch_points: ["main", "HEAD~1", "HEAD"],
      },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.branchPointsPreparationFailed, true);
    assert.equal(result.details.stackInitializationRun, false);
    assert.deepEqual(calls, []);
    for (const branch of ["stack-base", "stack-base/nested"]) {
      assert.equal(
        spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd })
          .status,
        1,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack restores the owned branch after init traverses branches", async () => {
  const cwd = createRepository();
  try {
    git(cwd, ["branch", "other"]);
    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      git(cwd, ["switch", "other"]);
      return { stdout: "Stack initialized\n", stderr: "" };
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");

    const invalid = await tool.execute(
      "create-other-stack",
      { branches: ["other"] },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(invalid.details.invalidParameters, true);
    assert.deepEqual(calls, []);

    const result = await tool.execute(
      "create-stack",
      { branches: ["feature"] },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackCreated, true);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.deepEqual(calls, ["stack init -- feature"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("push_and_check_ci preserves a conflict from the middle of a stack rebase", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    writeFileSync(join(cwd, "file.txt"), "feature\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    git(cwd, ["switch", "main"]);
    writeFileSync(join(cwd, "file.txt"), "trunk\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "trunk"]);
    git(cwd, ["switch", "feature"]);
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "origin", "main", "feature"]);

    const stackRunner: GhStackCommandRunner = async (args) => {
      if (args[1] === "view") {
        return { stdout: '{"branches":[{"branch":"feature"}]}', stderr: "" };
      }
      assert.equal(args[1], "sync");
      const rebase = spawnSync("git", ["rebase", "main"], { cwd, encoding: "utf8" });
      assert.notEqual(rebase.status, 0);
      const statePath = git(cwd, ["rev-parse", "--git-path", "gh-stack-rebase-state"]);
      writeFileSync(join(cwd, statePath), "{}\n");
      throw Object.assign(new Error("stack conflict"), {
        stdout: rebase.stdout,
        stderr: rebase.stderr,
      });
    };
    const tool = requireTool(registeredTools({ stackRunner }), "push_and_check_ci");

    const result = await tool.execute("push", {}, undefined, undefined, { cwd });

    assert.equal(result.details.stackSyncConflict, true);
    assert.equal(result.details.rebaseStatePreserved, true);
    assert.deepEqual(result.details.conflictPaths, ["file.txt"]);
    assert.notEqual(git(cwd, ["ls-files", "-u"]), "");
    assert.equal(
      spawnSync("git", ["rev-parse", "--verify", "-q", "REBASE_HEAD"], { cwd }).status,
      0,
    );
    git(cwd, ["rebase", "--abort"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci bootstraps an unpublished stack branch before sync", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "origin", "main"]);
    git(cwd, ["branch", "--set-upstream-to", "origin/main", "feature"]);

    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        return { stdout: '{"branches":[{"branch":"feature"}]}', stderr: "" };
      }
      assert.equal(args[1], "sync");
      assert.notEqual(git(cwd, ["ls-remote", "--heads", "origin", "feature"]), "");
      throw new Error("intentionally stop before CI polling");
    };
    const tool = requireTool(registeredTools({ stackRunner }), "push_and_check_ci");

    const result = await tool.execute("push", {}, undefined, undefined, { cwd });

    assert.equal(result.details.stackSyncFailed, true);
    assert.equal(git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feature");
    assert.deepEqual(calls, ["stack view --json", "stack sync"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci publishes every missing stack branch before sync", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["branch", "stack-base", "main"]);
    git(cwd, ["push", "origin", "main"]);

    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        return {
          stdout:
            '{"branches":[{"branch":"stack-base"},{"branch":"feature"}],"currentBranch":"feature"}',
          stderr: "",
        };
      }
      assert.equal(args[1], "sync");
      assert.notEqual(git(cwd, ["ls-remote", "--heads", "origin", "stack-base"]), "");
      assert.notEqual(git(cwd, ["ls-remote", "--heads", "origin", "feature"]), "");
      assert.equal(git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feature");
      assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
      throw new Error("intentionally stop before CI polling");
    };
    const tool = requireTool(registeredTools({ stackRunner }), "push_and_check_ci");

    const result = await tool.execute("push", {}, undefined, undefined, { cwd });

    assert.equal(result.details.stackSyncFailed, true);
    assert.deepEqual(calls, ["stack view --json", "stack sync"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci stops on stack probe and submit failures", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    const probeFailure: GhStackCommandRunner = async () => {
      throw new Error("gh: unknown command stack");
    };
    const probeTool = requireTool(
      registeredTools({ stackRunner: probeFailure }),
      "push_and_check_ci",
    );
    const probeResult = await probeTool.execute("push", {}, undefined, undefined, { cwd });
    assert.equal(probeResult.details.stackProbeFailed, true);

    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "origin", "feature"]);
    git(cwd, ["branch", "other"]);
    const calls: string[] = [];
    const submitFailure: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        return { stdout: '{"branches":[{"branch":"feature"}]}', stderr: "" };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      git(cwd, ["switch", "other"]);
      throw new Error("submit failed");
    };
    const submitTool = requireTool(
      registeredTools({ stackRunner: submitFailure }),
      "push_and_check_ci",
    );
    const submitResult = await submitTool.execute("push", {}, undefined, undefined, { cwd });

    assert.equal(submitResult.details.stackSubmitFailed, true);
    assert.equal(submitResult.details.workspaceRestored, true);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.deepEqual(calls, ["stack view --json", "stack sync", "stack submit --auto"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
