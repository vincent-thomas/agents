import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixCiExtension } from "./index.ts";
import type { GhStackCommandRunner, WorkspaceBranchRestorer } from "./github-stack.ts";
import type { StackReadinessRunner } from "./stack-readiness.ts";

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
  stackReadinessRunner?: StackReadinessRunner;
}): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const extension = createFixCiExtension({
    assertWorkspace: async () => {},
    stackRunner: options.stackRunner,
    restoreBranch: options.restoreBranch,
    stackReadinessRunner: options.stackReadinessRunner,
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
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/stack-first"], { cwd })
        .status,
      1,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack rolls back refs when membership cannot be confirmed as a stack", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "init") throw new Error("current branch is already part of a stack");
      throw new Error('current branch "feature" is not part of a stack');
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");
    const result = await tool.execute(
      "membership-probe-failed",
      { branches: ["new-middle", "feature"], branch_points: ["main", "HEAD"] },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackCreationFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.workspaceRestored, true);
    assert.equal(result.details.rollbackOutput, "");
    assert.deepEqual(calls, ["stack init -- new-middle feature", "stack view --json"]);
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/new-middle"], { cwd })
        .status,
      1,
    );
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

test("create_github_stack extends an existing stack with a materialized middle branch", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature one\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature one"]);
    writeFileSync(join(cwd, "file.txt"), "feature two\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature two"]);
    const calls: string[] = [];
    let initCount = 0;
    let viewCount = 0;
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "init") {
        initCount++;
        if (initCount === 1) throw new Error("current branch is already part of a stack");
        git(cwd, ["switch", "main"]);
        return { stdout: "replacement stack initialized", stderr: "" };
      }
      if (args[1] === "view") {
        viewCount++;
        assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
        return {
          stdout:
            viewCount === 1
              ? '{"trunk":"main","branches":[{"branch":"main"},{"branch":"feature"}]}'
              : '{"trunk":"main","branches":[{"branch":"main"},{"branch":"middle"},{"branch":"feature"}]}',
          stderr: "",
        };
      }
      assert.deepEqual(args, ["stack", "unstack", "--local"]);
      return { stdout: "unstacked", stderr: "" };
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");
    const result = await tool.execute(
      "extend-stack",
      { branches: ["main", "middle", "feature"], branch_points: ["main", "HEAD~1", "HEAD"] },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackCreated, true, JSON.stringify(result.details));
    assert.equal(result.details.stackExtended, true, JSON.stringify(result.details));
    assert.equal(result.details.replacementVerified, true, JSON.stringify(result.details));
    assert.equal(result.details.replacementBranchesMatch, true);
    assert.equal(result.details.replacementBaseMatch, true);
    assert.deepEqual(result.details.previousBranches, ["main", "feature"]);
    assert.deepEqual(result.details.requestedBranches, ["main", "middle", "feature"]);
    assert.deepEqual(result.details.materializedBranches, ["middle"]);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.equal(git(cwd, ["rev-parse", "middle"]), git(cwd, ["rev-parse", "HEAD~1"]));
    assert.deepEqual(calls, [
      "stack init -- main middle feature",
      "stack view --json",
      "stack unstack --local",
      "stack init --base main -- main middle feature",
      "stack view --json",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack recovers when local unstack removes state before failing", async () => {
  const cwd = createRepository();
  try {
    const calls: string[] = [];
    const signalValues: (AbortSignal | undefined)[] = [];
    const restoreSignals: (AbortSignal | undefined)[] = [];
    let initCount = 0;
    let unstackCount = 0;
    let stackPresent = true;
    const stackRunner: GhStackCommandRunner = async (args, options) => {
      calls.push(args.join(" "));
      signalValues.push(options.signal);
      if (args[1] === "init") {
        initCount++;
        if (initCount === 1) throw new Error("current branch is already part of a stack");
        stackPresent = true;
        return { stdout: "previous stack initialized", stderr: "" };
      }
      if (args[1] === "view") {
        assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
        return {
          stdout: stackPresent
            ? '{"trunk":"main","branches":[{"branch":"main"},{"branch":"feature"}]}'
            : '{"branches":[]}',
          stderr: "",
        };
      }
      unstackCount++;
      if (unstackCount === 1) {
        stackPresent = false;
        throw new Error("unstack failed after removing local state");
      }
      return { stdout: "cleanup complete", stderr: "" };
    };
    const tool = requireTool(
      registeredTools({
        stackRunner,
        restoreBranch: async (_cwd, branch, signal) => {
          assert.equal(branch, "feature");
          restoreSignals.push(signal);
          return { success: true, output: "restored checkout" };
        },
      }),
      "create_github_stack",
    );
    const result = await tool.execute(
      "recover-unstack",
      { branches: ["main", "middle", "feature"] },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackExtensionFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.previousStackRestored, true, JSON.stringify(result.details));
    assert.equal(result.details.previousStackCheckoutRestored, true);
    assert.equal(result.details.previousStackInitSuccess, true);
    assert.equal(result.details.previousInitSuccess, true);
    assert.deepEqual(calls, [
      "stack init -- main middle feature",
      "stack view --json",
      "stack unstack --local",
      "stack unstack --local",
      "stack init --base main -- main feature",
      "stack view --json",
    ]);
    assert.equal(signalValues[2], undefined);
    assert.equal(signalValues[3], undefined);
    assert.equal(signalValues[4], undefined);
    assert.equal(signalValues[5], undefined);
    assert.deepEqual(restoreSignals, [undefined]);
    const outputs = result.details.operationOutputs as Record<string, unknown>;
    assert.equal(outputs.cleanupUnstack, "cleanup complete");
    assert.equal(outputs.previousStackInit, "previous stack initialized");
    assert.equal(outputs.previousStackInitSuccess, true);
    assert.equal(outputs.previousStackRestore, "restored checkout");
    assert.equal(outputs.previousStackRestoreSuccess, true);
    assert.match(String(outputs.previousStackProbe), /trunk/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack rejects an omitted existing branch and rolls back new refs", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    const stackRunner: GhStackCommandRunner = async (args) => {
      if (args[1] === "init") throw new Error("current branch is already part of a stack");
      assert.equal(args[1], "view");
      return {
        stdout: '{"trunk":"main","branches":[{"branch":"main"},{"branch":"feature"}]}',
        stderr: "",
      };
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");
    const result = await tool.execute(
      "reject-extension",
      { branches: ["new-middle", "feature"], branch_points: ["main", "HEAD"] },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackExtensionFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.previousStackRestored, true);
    assert.equal(result.details.workspaceRestored, true);
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/new-middle"], { cwd })
        .status,
      1,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack rejects extension when the existing base is unknown", async () => {
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
      if (args[1] === "init") throw new Error("current branch is already part of a stack");
      if (args[1] === "view") {
        return { stdout: '{"branches":[{"branch":"main"},{"branch":"feature"}]}', stderr: "" };
      }
      throw new Error("local unstack must not run when the existing base is unknown");
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");
    const result = await tool.execute(
      "reject-unknown-base",
      {
        base: "caller-base",
        branches: ["main", "middle", "feature"],
        branch_points: ["main", "HEAD~1", "HEAD"],
      },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackExtensionFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.existingBaseUnknown, true);
    assert.equal(result.details.previousBase, null);
    assert.equal(result.details.workspaceRestored, true);
    assert.deepEqual(calls, [
      "stack init --base caller-base -- main middle feature",
      "stack view --json",
    ]);
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/middle"], { cwd }).status,
      1,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack rejects a mismatched base before replacing an extended stack", async () => {
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
      if (args[1] === "init") throw new Error("current branch is already part of a stack");
      if (args[1] === "view") {
        return {
          stdout: '{"trunk":"main","branches":[{"branch":"main"},{"branch":"feature"}]}',
          stderr: "",
        };
      }
      throw new Error("local unstack must not run for a mismatched base");
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");
    const result = await tool.execute(
      "reject-mismatched-base",
      {
        base: "other-base",
        branches: ["main", "middle", "feature"],
        branch_points: ["main", "HEAD~1", "HEAD"],
      },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackExtensionFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.requestedBase, "other-base");
    assert.equal(result.details.previousBase, "main");
    assert.equal(result.details.workspaceRestored, true);
    assert.deepEqual(calls, [
      "stack init --base other-base -- main middle feature",
      "stack view --json",
    ]);
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/middle"], { cwd }).status,
      1,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack does not report recovery when restoring the old stack init fails", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    writeFileSync(join(cwd, "file.txt"), "feature two\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature two"]);
    const calls: string[] = [];
    let initCount = 0;
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "init") {
        initCount++;
        if (initCount === 1) throw new Error("current branch is already part of a stack");
        if (initCount === 2) {
          git(cwd, ["switch", "main"]);
          throw new Error("replacement failed");
        }
        throw new Error("old stack restore failed");
      }
      if (args[1] === "view") {
        return {
          stdout: '{"trunk":"custom-base","branches":[{"branch":"main"},{"branch":"feature"}]}',
          stderr: "",
        };
      }
      return { stdout: "unstacked", stderr: "" };
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");
    const result = await tool.execute(
      "failed-extension",
      {
        base: "custom-base",
        branches: ["main", "middle", "feature"],
        branch_points: ["main", "HEAD~1", "HEAD"],
      },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackExtensionFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.previousStackRestored, false);
    assert.equal(result.details.previousStackInitSuccess, false);
    assert.equal(result.details.previousInitSuccess, false);
    assert.equal(result.details.previousBase, "custom-base");
    assert.equal(result.details.workspaceRestored, true);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/middle"], { cwd }).status,
      1,
    );
    assert.deepEqual(calls.slice(-4), [
      "stack init --base custom-base -- main middle feature",
      "stack unstack --local",
      "stack init --base custom-base -- main feature",
      "stack view --json",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack uses signal-free cleanup after replacement cancellation", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    writeFileSync(join(cwd, "file.txt"), "feature two\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature two"]);
    const controller = new AbortController();
    let initCount = 0;
    const calls: string[] = [];
    const cleanupSignals: (AbortSignal | undefined)[] = [];
    const stackRunner: GhStackCommandRunner = async (args, options) => {
      calls.push(args.join(" "));
      if (args[1] === "init") {
        initCount++;
        if (initCount === 1) throw new Error("current branch is already part of a stack");
        if (initCount === 2) {
          git(cwd, ["switch", "main"]);
          controller.abort();
          throw new Error("replacement cancelled");
        }
        cleanupSignals.push(options.signal);
        return { stdout: "old stack restored", stderr: "" };
      }
      if (args[1] === "view") {
        return {
          stdout: '{"trunk":"main","branches":[{"branch":"main"},{"branch":"feature"}]}',
          stderr: "",
        };
      }
      cleanupSignals.push(options.signal);
      return { stdout: "unstacked", stderr: "" };
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");
    const result = await tool.execute(
      "cancel-extension",
      { branches: ["main", "middle", "feature"], branch_points: ["main", "HEAD~1", "HEAD"] },
      controller.signal,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackExtensionFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.previousStackRestored, true);
    assert.equal(result.details.previousBase, "main");
    assert.equal(result.details.workspaceRestored, true);
    assert.equal(cleanupSignals[0], controller.signal);
    assert.deepEqual(cleanupSignals.slice(1), [undefined, undefined]);
    assert.deepEqual(calls, [
      "stack init -- main middle feature",
      "stack view --json",
      "stack unstack --local",
      "stack init --base main -- main middle feature",
      "stack unstack --local",
      "stack init --base main -- main feature",
      "stack view --json",
    ]);
    assert.equal(
      typeof (result.details.operationOutputs as Record<string, unknown>).previousStackProbe,
      "string",
    );
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/middle"], { cwd }).status,
      1,
    );
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
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
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
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
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
            '{"trunk":"main","branches":[{"branch":"stack-base"},{"branch":"feature"}],"currentBranch":"feature"}',
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

test("push_and_check_ci wires successful stack submission into readiness", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["branch", "stack-base", "main"]);
    git(cwd, ["push", "origin", "main", "feature", "stack-base"]);

    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        return {
          stdout: '{"trunk":"main","branches":[{"branch":"stack-base"},{"branch":"feature"}]}',
          stderr: "",
        };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      assert.equal(args[1], "submit");
      return { stdout: "submitted", stderr: "" };
    };
    let readinessBranches: readonly string[] = [];
    const stackReadinessRunner: StackReadinessRunner = async (_cwd, branches) => {
      readinessBranches = branches;
      return {
        allChecksPassed: true,
        allReady: true,
        branches: branches.map((branch, index) => ({
          branch,
          sha: `sha-${index}`,
          prNumber: index + 1,
          prState: "OPEN",
          prHeadRefOid: `sha-${index}`,
          isDraft: true,
          checks: [],
          timedOut: false,
          polls: 0,
          mode: `commit sha-${index}`,
          failureLogs: [],
          ready: true,
        })),
      };
    };
    const tool = requireTool(
      registeredTools({ stackRunner, stackReadinessRunner }),
      "push_and_check_ci",
    );

    const result = await tool.execute("push", {}, undefined, undefined, { cwd });

    assert.deepEqual(readinessBranches, ["stack-base", "feature"]);
    assert.equal(result.details.allChecksPassed, true);
    assert.equal(result.details.allReady, true);
    assert.deepEqual(
      (result.details.branches as Array<{ branch: string }>).map((branch) => branch.branch),
      ["stack-base", "feature"],
    );
    assert.deepEqual(calls, ["stack view --json", "stack sync", "stack submit --auto"]);
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
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
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
