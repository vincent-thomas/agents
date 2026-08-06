import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixCiExtension } from "./index.ts";
import type { GhStackCommandRunner, WorkspaceBranchRestorer } from "./github-stack.ts";
import type { WorkspaceController, WorkspaceControllerClaim } from "./index.ts";
import type { StackReadinessRunner } from "./stack-readiness.ts";

type RegisteredTool = {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string },
  ): Promise<{
    details: Record<string, unknown>;
    content?: Array<{ type: string; text: string }>;
  }>;
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

function addOrigin(cwd: string): string {
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  git(remote, ["init", "--bare"]);
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "origin", "main", "feature"]);
  return remote;
}

function readyStack(branches: readonly string[]) {
  return {
    allChecksPassed: true,
    allReady: true,
    branches: branches.map((branch, index) => ({
      branch,
      sha: `sha-${index}`,
      prNumber: index + 1,
      prState: "OPEN" as const,
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
}

function registeredTools(options: {
  stackRunner: GhStackCommandRunner;
  restoreBranch?: WorkspaceBranchRestorer;
  workspaceController?: WorkspaceController;
  stackReadinessRunner?: StackReadinessRunner;
  assertWorkspace?: () => void | Promise<void>;
}): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const extension = createFixCiExtension({
    assertWorkspace: options.assertWorkspace ?? (async () => {}),
    stackRunner: options.stackRunner,
    restoreBranch: options.restoreBranch,
    workspaceController: options.workspaceController,
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

type StackFixtureMember = {
  branch: string;
  /** Set null to model an enriched view that omits its local head. */
  head?: string | null;
  pr?: { number: number; state?: string; draft?: boolean; url?: string };
};

/** Small enriched-view runner whose current marker follows the real checkout. */
function stackFixture(
  cwd: string,
  members: readonly StackFixtureMember[],
  options: {
    base?: string;
    remote?: unknown;
    checkout?: (branch: string, signal: AbortSignal | undefined) => void;
  } = {},
): { runner: GhStackCommandRunner; calls: string[] } {
  const calls: string[] = [];
  const base = options.base ?? "main";
  const runner: GhStackCommandRunner = async (args, runnerOptions) => {
    calls.push(args.join(" "));
    if (args[0] === "api") {
      assert.notEqual(options.remote, undefined, "unexpected remote API request");
      return { stdout: JSON.stringify(options.remote), stderr: "" };
    }
    if (args[1] === "view") {
      const current = git(cwd, ["branch", "--show-current"]);
      return {
        stdout: JSON.stringify({
          trunk: base,
          currentBranch: current,
          branches: members.map((member) => ({
            name: member.branch,
            head: member.head === undefined ? git(cwd, ["rev-parse", member.branch]) : member.head,
            base,
            isCurrent: member.branch === current,
            isMerged: false,
            isQueued: false,
            needsRebase: false,
            ...(member.pr
              ? {
                  pr: {
                    number: member.pr.number,
                    url: member.pr.url ?? `https://github.com/acme/repo/pull/${member.pr.number}`,
                    state: member.pr.state ?? "OPEN",
                    draft: member.pr.draft ?? true,
                  },
                }
              : {}),
          })),
        }),
        stderr: "",
      };
    }
    if (args[1] === "checkout") {
      const branch = args[3];
      assert.equal(typeof branch, "string");
      const targetBranch = branch as string;
      git(cwd, ["switch", "--", targetBranch]);
      options.checkout?.(targetBranch, runnerOptions.signal);
      return { stdout: `checked out ${branch}`, stderr: "" };
    }
    throw new Error(`unexpected stack command: ${args.join(" ")}`);
  };
  return { runner, calls };
}

function remoteStack(
  members: readonly {
    number: number;
    branch: string;
    sha: string;
    state?: string;
    draft?: boolean;
  }[],
  base = "main",
) {
  return [
    {
      id: 1,
      number: 99,
      url: "https://github.com/acme/repo/stack/99",
      base: { ref: base },
      open: true,
      pull_requests: members.map((member) => ({
        number: member.number,
        state: member.state ?? "OPEN",
        draft: member.draft ?? false,
        merged_at: null,
        head: { ref: member.branch, sha: member.sha },
      })),
    },
  ];
}

function controllerFixture(
  initialSnapshot: { activeBranch: string | null; branches: string[]; baseBranch: string | null },
  options: {
    validate?: (claim: WorkspaceControllerClaim) => void;
    claim?: (claim: WorkspaceControllerClaim) => void;
    restore?: () => void;
    onCall?: (call: string) => void;
  } = {},
) {
  let state = {
    activeBranch: initialSnapshot.activeBranch,
    branches: [...initialSnapshot.branches],
    baseBranch: initialSnapshot.baseBranch,
  };
  const calls: string[] = [];
  const claims: WorkspaceControllerClaim[] = [];
  const record = (call: string) => {
    calls.push(call);
    options.onCall?.(call);
  };
  const controller: WorkspaceController = {
    snapshot: async () => {
      record("snapshot");
      return { ...state, branches: [...state.branches] };
    },
    validate: async (_cwd, claim) => {
      record("validate");
      options.validate?.(claim);
    },
    claim: async (_cwd, claim) => {
      record("claim");
      options.claim?.(claim);
      claims.push({ ...claim, branches: [...claim.branches] });
      state = { ...claim, branches: [...claim.branches] };
    },
    restore: async (_cwd, snapshot) => {
      record("restore");
      options.restore?.();
      state = { ...snapshot, branches: [...snapshot.branches] };
    },
  };
  return {
    controller,
    calls,
    claims,
    snapshot: () => ({ ...state, branches: [...state.branches] }),
  };
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

test("create_github_stack adopts an ordinary explicit-base stack", async () => {
  const cwd = createRepository();
  try {
    const stackCalls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      stackCalls.push(args.join(" "));
      assert.deepEqual(args, ["stack", "init", "--base", "main", "--", "main", "feature"]);
      return { stdout: "initialized", stderr: "" };
    };
    const ownership = controllerFixture({
      activeBranch: "feature",
      branches: ["feature"],
      baseBranch: null,
    });
    const result = await requireTool(
      registeredTools({ stackRunner, workspaceController: ownership.controller }),
      "create_github_stack",
    ).execute(
      "adopt-ordinary",
      { branches: ["main", "feature"], base: "main" },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackCreated, true, JSON.stringify(result.details));
    assert.equal(result.details.workspaceOwnership, "adopted");
    assert.deepEqual(result.details.branches, ["main", "feature"]);
    assert.equal(result.details.base, "main");
    assert.deepEqual(result.details.workspaceOwnershipClaim, {
      activeBranch: "feature",
      branches: ["main", "feature"],
      baseBranch: "main",
    });
    assert.deepEqual(ownership.claims, [
      { activeBranch: "feature", branches: ["main", "feature"], baseBranch: "main" },
    ]);
    assert.deepEqual(ownership.snapshot(), {
      activeBranch: "feature",
      branches: ["main", "feature"],
      baseBranch: "main",
    });
    assert.deepEqual(stackCalls, ["stack init --base main -- main feature"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack preserves materialized refs when ownership adoption fails", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    writeFileSync(join(cwd, "file.txt"), "feature two\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature two"]);
    const stackCalls: string[] = [];
    let stackInitialized = false;
    const stackRunner: GhStackCommandRunner = async (args) => {
      stackCalls.push(args.join(" "));
      assert.deepEqual(args, [
        "stack",
        "init",
        "--base",
        "main",
        "--",
        "main",
        "middle",
        "feature",
      ]);
      stackInitialized = true;
      return { stdout: "initialized", stderr: "" };
    };
    const ownership = controllerFixture(
      { activeBranch: "feature", branches: ["feature"], baseBranch: null },
      {
        claim: () => {
          throw new Error("registry rejected adoption");
        },
      },
    );
    const result = await requireTool(
      registeredTools({ stackRunner, workspaceController: ownership.controller }),
      "create_github_stack",
    ).execute(
      "adopt-failure",
      {
        branches: ["main", "middle", "feature"],
        base: "main",
        branch_points: ["main", "HEAD~1", "HEAD"],
      },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.workspaceOwnershipFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.stackCreated, undefined);
    assert.equal(stackInitialized, true);
    assert.deepEqual(stackCalls, ["stack init --base main -- main middle feature"]);
    for (const branch of ["main", "middle", "feature"]) {
      assert.equal(
        spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd })
          .status,
        0,
      );
    }
    assert.deepEqual(ownership.snapshot(), {
      activeBranch: "feature",
      branches: ["feature"],
      baseBranch: null,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("create_github_stack adopts existing and replacement stacks exactly", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    writeFileSync(join(cwd, "file.txt"), "feature two\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature two"]);
    const stackCalls: string[] = [];
    let initCount = 0;
    let viewCount = 0;
    const stackRunner: GhStackCommandRunner = async (args) => {
      stackCalls.push(args.join(" "));
      if (args[1] === "init") {
        initCount++;
        if (initCount < 3) throw new Error("current branch is already part of a stack");
        return { stdout: "replacement initialized", stderr: "" };
      }
      if (args[1] === "view") {
        viewCount++;
        return {
          stdout: JSON.stringify({
            trunk: "main",
            branches:
              viewCount <= 2
                ? [{ branch: "main" }, { branch: "feature" }]
                : [{ branch: "main" }, { branch: "middle" }, { branch: "feature" }],
          }),
          stderr: "",
        };
      }
      assert.deepEqual(args, ["stack", "unstack", "--local"]);
      return { stdout: "unstacked", stderr: "" };
    };
    const ownership = controllerFixture({
      activeBranch: "feature",
      branches: ["feature"],
      baseBranch: null,
    });
    const tool = requireTool(
      registeredTools({ stackRunner, workspaceController: ownership.controller }),
      "create_github_stack",
    );
    const existing = await tool.execute(
      "adopt-existing",
      { branches: ["main", "feature"], base: "main" },
      undefined,
      undefined,
      { cwd },
    );
    const replacement = await tool.execute(
      "adopt-replacement",
      {
        branches: ["main", "middle", "feature"],
        base: "main",
        branch_points: ["main", "HEAD~1", "HEAD"],
      },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(existing.details.stackCreated, true, JSON.stringify(existing.details));
    assert.equal(existing.details.workspaceOwnership, "adopted");
    assert.equal(replacement.details.stackCreated, true, JSON.stringify(replacement.details));
    assert.equal(replacement.details.workspaceOwnership, "adopted");
    assert.deepEqual(replacement.details.workspaceOwnershipClaim, {
      activeBranch: "feature",
      branches: ["main", "middle", "feature"],
      baseBranch: "main",
    });
    assert.deepEqual(ownership.claims, [
      { activeBranch: "feature", branches: ["main", "feature"], baseBranch: "main" },
      { activeBranch: "feature", branches: ["main", "middle", "feature"], baseBranch: "main" },
    ]);
    assert.deepEqual(ownership.snapshot(), {
      activeBranch: "feature",
      branches: ["main", "middle", "feature"],
      baseBranch: "main",
    });
    assert.deepEqual(stackCalls, [
      "stack init --base main -- main feature",
      "stack view --json",
      "stack init --base main -- main middle feature",
      "stack view --json",
      "stack unstack --local",
      "stack init --base main -- main middle feature",
      "stack view --json",
    ]);
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

test("create_github_stack rejects a stack probe that omits the owned branch", async () => {
  const cwd = createRepository();
  try {
    writeFileSync(join(cwd, "file.txt"), "feature\n");
    git(cwd, ["add", "file.txt"]);
    git(cwd, ["commit", "-m", "feature"]);
    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "init") throw new Error("current branch is already part of a stack");
      assert.equal(args[1], "view");
      return {
        stdout: '{"trunk":"main","branches":[{"branch":"other"}]}',
        stderr: "",
      };
    };
    const tool = requireTool(registeredTools({ stackRunner }), "create_github_stack");
    const result = await tool.execute(
      "reject-mismatched-stack",
      { branches: ["middle", "feature"], branch_points: ["main", "HEAD"] },
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.stackExtensionFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.stackProbeMismatch, true);
    assert.equal(result.details.workspaceRestored, true);
    assert.deepEqual(calls, ["stack init -- middle feature", "stack view --json"]);
    assert.equal(
      spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/middle"], { cwd }).status,
      1,
    );
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

test("push_and_check_ci claims a legacy singleton before stack sync", async () => {
  const cwd = createRepository();
  const remote = addOrigin(cwd);
  try {
    const events: string[] = [];
    const ownership = controllerFixture(
      { activeBranch: "feature", branches: ["feature"], baseBranch: "main" },
      { onCall: (call) => events.push(call) },
    );
    const stackRunner: GhStackCommandRunner = async (args) => {
      events.push(args.join(" "));
      if (args[1] === "view") {
        return {
          stdout: '{"trunk":"main","branches":[{"branch":"main"},{"branch":"feature"}]}',
          stderr: "",
        };
      }
      assert.deepEqual(args, ["stack", "sync"]);
      assert.deepEqual(ownership.snapshot(), {
        activeBranch: "feature",
        branches: ["main", "feature"],
        baseBranch: "main",
      });
      throw new Error("stop after ownership adoption");
    };
    const result = await requireTool(
      registeredTools({ stackRunner, workspaceController: ownership.controller }),
      "push_and_check_ci",
    ).execute("legacy-push", {}, undefined, undefined, { cwd });

    assert.equal(result.details.stackSyncFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.workspaceOwnership, "adopted");
    assert.deepEqual(ownership.claims, [
      { activeBranch: "feature", branches: ["main", "feature"], baseBranch: "main" },
    ]);
    assert.deepEqual(events, ["stack view --json", "snapshot", "validate", "claim", "stack sync"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci reclaims refreshed membership before link and readiness", async () => {
  const cwd = createRepository();
  git(cwd, ["branch", "middle", "main"]);
  const remote = addOrigin(cwd);
  try {
    git(cwd, ["push", "origin", "middle"]);
    const events: string[] = [];
    const ownership = controllerFixture(
      { activeBranch: "feature", branches: ["feature"], baseBranch: "main" },
      { onCall: (call) => events.push(call) },
    );
    let viewCount = 0;
    const stackRunner: GhStackCommandRunner = async (args) => {
      events.push(args.join(" "));
      if (args[1] === "view") {
        viewCount++;
        return {
          stdout: JSON.stringify({
            trunk: "main",
            branches:
              viewCount === 1
                ? [{ branch: "main" }, { branch: "feature" }]
                : [{ branch: "main" }, { branch: "middle" }, { branch: "feature" }],
          }),
          stderr: "",
        };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      if (args[1] === "submit") return { stdout: "submitted", stderr: "" };
      assert.deepEqual(args, [
        "stack",
        "link",
        "--base",
        "main",
        "--",
        "main",
        "middle",
        "feature",
      ]);
      return { stdout: "linked", stderr: "" };
    };
    const result = await requireTool(
      registeredTools({
        stackRunner,
        workspaceController: ownership.controller,
        stackReadinessRunner: async (_cwd, branches) => {
          events.push("readiness");
          assert.deepEqual(branches, ["main", "middle", "feature"]);
          return readyStack(branches);
        },
      }),
      "push_and_check_ci",
    ).execute("refreshed-push", {}, undefined, undefined, { cwd });

    assert.equal(result.details.stackSubmitSucceeded, true, JSON.stringify(result.details));
    assert.equal(result.details.stackLinkSucceeded, true);
    assert.equal(result.details.allReady, true);
    assert.deepEqual(result.details.workspaceOwnershipClaim, {
      activeBranch: "feature",
      branches: ["main", "middle", "feature"],
      baseBranch: "main",
    });
    assert.deepEqual(ownership.claims, [
      { activeBranch: "feature", branches: ["main", "feature"], baseBranch: "main" },
      { activeBranch: "feature", branches: ["main", "middle", "feature"], baseBranch: "main" },
    ]);
    assert.deepEqual(events, [
      "stack view --json",
      "snapshot",
      "validate",
      "claim",
      "stack sync",
      "stack submit --auto",
      "stack view --json",
      "snapshot",
      "validate",
      "claim",
      "stack link --base main -- main middle feature",
      "readiness",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci skips claim and stack mutation when validation is cancelled", async () => {
  const cwd = createRepository();
  try {
    const cancellation = new AbortController();
    const events: string[] = [];
    const ownership = controllerFixture(
      { activeBranch: "feature", branches: ["feature"], baseBranch: "main" },
      {
        onCall: (call) => events.push(call),
        validate: () => cancellation.abort(),
      },
    );
    const stackRunner: GhStackCommandRunner = async (args) => {
      events.push(args.join(" "));
      assert.deepEqual(args, ["stack", "view", "--json"]);
      return {
        stdout: '{"trunk":"main","branches":[{"branch":"main"},{"branch":"feature"}]}',
        stderr: "",
      };
    };
    const result = await requireTool(
      registeredTools({ stackRunner, workspaceController: ownership.controller }),
      "push_and_check_ci",
    ).execute("cancel-before-claim", {}, cancellation.signal, undefined, { cwd });

    assert.equal(result.details.stackSyncFailed, true, JSON.stringify(result.details));
    assert.equal(result.details.workspaceOwnershipFailed, true);
    assert.equal(
      (result.details.workspaceOwnershipFailure as { stage: string; cancelled: boolean }).stage,
      "cancelled",
    );
    assert.equal(
      (result.details.workspaceOwnershipFailure as { stage: string; cancelled: boolean }).cancelled,
      true,
    );
    assert.deepEqual(ownership.claims, []);
    assert.deepEqual(events, ["stack view --json", "snapshot", "validate"]);
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
    let viewCount = 0;
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        viewCount += 1;
        return {
          stdout:
            viewCount === 1
              ? '{"trunk":"main","branches":[{"branch":"stack-base"},{"branch":"feature"}]}'
              : '{"trunk":"main","branches":[{"branch":"feature"}]}',
          stderr: "",
        };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      if (args[1] === "submit") return { stdout: "submitted", stderr: "" };
      assert.deepEqual(args, ["stack", "link", "--base", "main", "--", "feature"]);
      return { stdout: "linked", stderr: "" };
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

    assert.deepEqual(readinessBranches, ["feature"]);
    assert.equal(result.details.allChecksPassed, true);
    assert.equal(result.details.allReady, true);
    assert.equal(result.details.stackSubmitSucceeded, true);
    assert.equal(result.details.stackLinkAttempted, true);
    assert.equal(result.details.stackLinkSucceeded, true);
    assert.equal(result.details.remoteStackLinked, true);
    assert.equal(result.details.stackLinkOutput, "linked");
    assert.equal(viewCount, 2);
    assert.equal(
      (result.details.postSubmitStackProbe as { output: string }).output,
      '{"trunk":"main","branches":[{"branch":"feature"}]}',
    );
    assert.equal(
      result.details.postSubmitStackProbeOutput,
      '{"trunk":"main","branches":[{"branch":"feature"}]}',
    );
    assert.deepEqual(
      (result.details.branches as Array<{ branch: string }>).map((branch) => branch.branch),
      ["feature"],
    );
    assert.deepEqual(calls, [
      "stack view --json",
      "stack sync",
      "stack submit --auto",
      "stack view --json",
      "stack link --base main -- feature",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci rebuilds a remote stack after an exact middle insertion rejection", async () => {
  const cwd = createRepository();
  const remote = addOrigin(cwd);
  try {
    const calls: string[] = [];
    let viewCount = 0;
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        viewCount++;
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      if (args[1] === "submit") return { stdout: "submitted", stderr: "" };
      if (
        args[1] === "link" &&
        calls.filter((call) => call.startsWith("stack link")).length === 1
      ) {
        const error = new Error("gh stack link failed") as Error & { stderr: string };
        error.stderr =
          "Cannot update stack: new PRs must be added to the top of the existing stack";
        throw error;
      }
      if (args[1] === "unstack") return { stdout: "remote unstacked", stderr: "" };
      if (args[1] === "init") return { stdout: "local tracking restored", stderr: "" };
      assert.deepEqual(args, ["stack", "link", "--base", "main", "--", "feature"]);
      return { stdout: "retry linked", stderr: "" };
    };
    let readinessCalled = false;
    const tool = requireTool(
      registeredTools({
        stackRunner,
        stackReadinessRunner: async (_cwd, branches) => {
          readinessCalled = true;
          return readyStack(branches);
        },
      }),
      "push_and_check_ci",
    );

    const result = await tool.execute("rebuild", {}, undefined, undefined, { cwd });

    assert.equal(readinessCalled, true);
    assert.equal(result.details.remoteStackRebuilt, true);
    assert.equal(result.details.remoteStackLinked, true);
    assert.deepEqual(calls, [
      "stack view --json",
      "stack sync",
      "stack submit --auto",
      "stack view --json",
      "stack link --base main -- feature",
      "stack unstack",
      "stack init --base main -- feature",
      "stack link --base main -- feature",
    ]);
    assert.equal(
      result.details.initialLinkOutput,
      "Cannot update stack: new PRs must be added to the top of the existing stack",
    );
    assert.equal(result.details.remoteUnstackOutput, "remote unstacked");
    assert.equal(result.details.localInitOutput, "local tracking restored");
    assert.equal(result.details.retryLinkOutput, "retry linked");
    assert.equal(result.details.initialLinkRestorationOutput, "");
    assert.equal(result.details.remoteUnstackRestorationOutput, "");
    assert.equal(result.details.localInitRestorationOutput, "");
    assert.equal(result.details.retryLinkRestorationOutput, "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci stops after remote unstack failure without readiness", async () => {
  const cwd = createRepository();
  const remote = addOrigin(cwd);
  try {
    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view")
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      if (args[1] === "submit") return { stdout: "submitted", stderr: "" };
      if (
        args[1] === "link" &&
        calls.filter((call) => call.startsWith("stack link")).length === 1
      ) {
        throw new Error(
          "Cannot update stack: new PRs must be added to the top of the existing stack",
        );
      }
      if (args[1] === "unstack") throw new Error("remote unstack failed");
      if (args[1] === "init") return { stdout: "tracking cleanup", stderr: "" };
      throw new Error("retry must not run");
    };
    let readinessCalled = false;
    const result = await requireTool(
      registeredTools({
        stackRunner,
        stackReadinessRunner: async () => {
          readinessCalled = true;
          return readyStack(["feature"]);
        },
      }),
      "push_and_check_ci",
    ).execute("unstack-failure", {}, undefined, undefined, { cwd });

    assert.equal(result.details.remoteStackRebuildAttempted, true);
    assert.equal(result.details.remoteUnstackSucceeded, false);
    assert.equal(result.details.remoteStackState, "unknown");
    assert.equal(result.details.remoteStackUnstacked, undefined);
    assert.equal(result.details.remoteStackRebuilt, false);
    assert.equal(result.details.remoteStackLinked, false);
    assert.equal(readinessCalled, false);
    assert.deepEqual(calls.slice(-2), ["stack unstack", "stack init --base main -- feature"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci reports failed local tracking recovery after remote unstack", async () => {
  const cwd = createRepository();
  const remote = addOrigin(cwd);
  try {
    let linkCount = 0;
    const stackRunner: GhStackCommandRunner = async (args) => {
      if (args[1] === "view")
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      if (args[1] === "submit") return { stdout: "submitted", stderr: "" };
      if (args[1] === "link") {
        linkCount++;
        if (linkCount === 1)
          throw new Error(
            "Cannot update stack: new PRs must be added to the top of the existing stack",
          );
        throw new Error("retry must not run");
      }
      if (args[1] === "unstack") return { stdout: "remote unstacked", stderr: "" };
      throw new Error("local tracking recovery failed");
    };
    const result = await requireTool(registeredTools({ stackRunner }), "push_and_check_ci").execute(
      "init-failure",
      {},
      undefined,
      undefined,
      { cwd },
    );

    assert.equal(result.details.remoteUnstackSucceeded, true);
    assert.equal(result.details.remoteStackState, "unstacked");
    assert.equal(result.details.localInitAttempted, true);
    assert.equal(result.details.localInitSucceeded, false);
    assert.equal(result.details.localTrackingRecoveryFailed, true);
    assert.equal(result.details.remoteStackRebuilt, false);
    assert.equal(result.details.remoteStackLinked, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci cleans up cancellation signal-free before retrying a rebuilt stack", async () => {
  const cwd = createRepository();
  const remote = addOrigin(cwd);
  try {
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    let linkCount = 0;
    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args, options) => {
      calls.push(args.join(" "));
      if (args[1] === "view")
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      if (args[1] === "submit") return { stdout: "submitted", stderr: "" };
      if (args[1] === "link") {
        signals.push(options.signal);
        git(cwd, ["switch", "main"]);
        linkCount++;
        if (linkCount === 1) {
          throw new Error(
            "Cannot update stack: new PRs must be added to the top of the existing stack",
          );
        }
        assert.equal(options.signal, controller.signal);
        assert.equal(options.signal?.aborted, true);
        throw new Error("retry cancelled");
      }
      if (args[1] === "unstack") {
        signals.push(options.signal);
        git(cwd, ["switch", "main"]);
        controller.abort();
        return { stdout: "remote unstacked", stderr: "" };
      }
      if (args[1] === "init") {
        signals.push(options.signal);
        git(cwd, ["switch", "main"]);
        return { stdout: "local tracking restored", stderr: "" };
      }
      return { stdout: "ok", stderr: "" };
    };
    const restoreSignals: (AbortSignal | undefined)[] = [];
    const result = await requireTool(
      registeredTools({
        stackRunner,
        restoreBranch: async (_cwd, branch, signal) => {
          restoreSignals.push(signal);
          assert.equal(branch, "feature");
          git(cwd, ["switch", branch]);
          return { success: true, output: `restored ${branch}` };
        },
      }),
      "push_and_check_ci",
    ).execute("cancel-rebuild", {}, controller.signal, undefined, { cwd });

    assert.equal(signals[0], controller.signal);
    assert.equal(signals[1], controller.signal);
    assert.equal(signals[2], undefined);
    assert.equal(signals[3], controller.signal);
    assert.equal(result.details.remoteStackState, "unstacked");
    assert.equal(result.details.remoteUnstackSucceeded, true);
    assert.equal(result.details.retryLinkSucceeded, false);
    assert.equal(result.details.remoteStackRebuilt, false);
    assert.equal(result.details.remoteStackLinked, false);
    assert.equal(result.details.readinessSkipped, true);
    assert.deepEqual(restoreSignals, [undefined, undefined, undefined, undefined]);
    assert.deepEqual(calls.slice(-4), [
      "stack link --base main -- feature",
      "stack unstack",
      "stack init --base main -- feature",
      "stack link --base main -- feature",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci stops before linking when the post-submit stack probe fails", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "origin", "main", "feature"]);

    const calls: string[] = [];
    const viewSignals: (AbortSignal | undefined)[] = [];
    let viewCount = 0;
    const stackRunner: GhStackCommandRunner = async (args, options) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        viewSignals.push(options.signal);
        viewCount += 1;
        if (viewCount === 2) throw new Error("post-submit probe failed");
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      assert.equal(args[1], "submit");
      return { stdout: "submitted", stderr: "" };
    };
    const controller = new AbortController();
    let readinessCalled = false;
    const tool = requireTool(
      registeredTools({
        stackRunner,
        stackReadinessRunner: async () => {
          readinessCalled = true;
          throw new Error("readiness must not run after post-submit probe failure");
        },
      }),
      "push_and_check_ci",
    );

    const result = await tool.execute(
      "post-submit-probe-failure",
      {},
      controller.signal,
      undefined,
      { cwd },
    );

    assert.deepEqual(viewSignals, [controller.signal, controller.signal]);
    assert.equal(result.details.stackSubmitSucceeded, true);
    assert.equal(result.details.stackLinkFailed, true);
    assert.equal(result.details.stackLinkAttempted, false);
    assert.equal(result.details.remoteStackLinked, false);
    assert.equal(result.details.postSubmitStackProbeFailed, true);
    assert.equal(
      (result.details.postSubmitStackProbe as { output: string }).output,
      "post-submit probe failed",
    );
    assert.equal(result.details.postSubmitStackProbeOutput, "post-submit probe failed");
    assert.equal(readinessCalled, false);
    assert.deepEqual(calls, [
      "stack view --json",
      "stack sync",
      "stack submit --auto",
      "stack view --json",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci skips linking and readiness when the stack base is unknown", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "origin", "main", "feature"]);

    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        return { stdout: '{"branches":[{"branch":"feature"}]}', stderr: "" };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      assert.equal(args[1], "submit");
      return { stdout: "submitted", stderr: "" };
    };
    let readinessCalled = false;
    const stackReadinessRunner: StackReadinessRunner = async () => {
      readinessCalled = true;
      throw new Error("readiness must not run when the stack base is unknown");
    };
    const tool = requireTool(
      registeredTools({ stackRunner, stackReadinessRunner }),
      "push_and_check_ci",
    );

    const result = await tool.execute("unknown-base", {}, undefined, undefined, { cwd });

    assert.equal(result.details.stackLinkFailed, true);
    assert.equal(result.details.remoteStackLinkFailed, true);
    assert.equal(result.details.stackLinkAttempted, false);
    assert.equal(result.details.remoteStackLinked, false);
    assert.equal(result.details.stackBaseUnknown, true);
    assert.equal(result.details.stackLinkOutput, undefined);
    assert.equal(readinessCalled, false);
    assert.deepEqual(calls, [
      "stack view --json",
      "stack sync",
      "stack submit --auto",
      "stack view --json",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci restores checkout after a successful remote stack link before readiness", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "origin", "main", "feature"]);
    git(cwd, ["branch", "other"]);

    const restoreSignals: (AbortSignal | undefined)[] = [];
    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      if (args[1] === "submit") return { stdout: "submitted", stderr: "" };
      assert.deepEqual(args, ["stack", "link", "--base", "main", "--", "feature"]);
      git(cwd, ["switch", "other"]);
      return { stdout: "linked", stderr: "" };
    };
    const stackReadinessRunner: StackReadinessRunner = async () => {
      assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
      return {
        allChecksPassed: true,
        allReady: true,
        branches: [
          {
            branch: "feature",
            sha: "sha-feature",
            prNumber: 1,
            prState: "OPEN",
            prHeadRefOid: "sha-feature",
            isDraft: true,
            checks: [],
            timedOut: false,
            polls: 0,
            mode: "commit sha-feature",
            failureLogs: [],
            ready: true,
          },
        ],
      };
    };
    const tool = requireTool(
      registeredTools({
        stackRunner,
        stackReadinessRunner,
        restoreBranch: async (_cwd, branch, signal) => {
          restoreSignals.push(signal);
          git(cwd, ["switch", branch]);
          return { success: true, output: "restored" };
        },
      }),
      "push_and_check_ci",
    );

    const result = await tool.execute("link-restoration", {}, undefined, undefined, { cwd });

    assert.deepEqual(restoreSignals, [undefined]);
    assert.equal(result.details.stackLinkAttempted, true);
    assert.equal(result.details.stackLinkSucceeded, true);
    assert.equal(result.details.remoteStackLinked, true);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.deepEqual(calls, [
      "stack view --json",
      "stack sync",
      "stack submit --auto",
      "stack view --json",
      "stack link --base main -- feature",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci forwards cancellation to link and restores without its aborted signal", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "origin", "main", "feature"]);
    git(cwd, ["branch", "other"]);

    const controller = new AbortController();
    const linkSignals: (AbortSignal | undefined)[] = [];
    const restoreSignals: (AbortSignal | undefined)[] = [];
    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args, options) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      if (args[1] === "submit") return { stdout: "submitted", stderr: "" };
      linkSignals.push(options.signal);
      assert.deepEqual(args, ["stack", "link", "--base", "main", "--", "feature"]);
      git(cwd, ["switch", "other"]);
      controller.abort();
      throw new Error("link cancelled");
    };
    let readinessCalled = false;
    const stackReadinessRunner: StackReadinessRunner = async () => {
      readinessCalled = true;
      throw new Error("readiness must not run after link cancellation");
    };
    const tool = requireTool(
      registeredTools({
        stackRunner,
        stackReadinessRunner,
        restoreBranch: async (_cwd, branch, signal) => {
          restoreSignals.push(signal);
          git(cwd, ["switch", branch]);
          return { success: true, output: "restored" };
        },
      }),
      "push_and_check_ci",
    );

    const result = await tool.execute("link-cancelled", {}, controller.signal, undefined, { cwd });

    assert.deepEqual(linkSignals, [controller.signal]);
    assert.deepEqual(restoreSignals, [undefined]);
    assert.equal(result.details.stackLinkFailed, true);
    assert.equal(result.details.remoteStackLinkFailed, true);
    assert.equal(result.details.stackLinkAttempted, true);
    assert.equal(result.details.remoteStackLinked, false);
    assert.equal(readinessCalled, false);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.deepEqual(calls, [
      "stack view --json",
      "stack sync",
      "stack submit --auto",
      "stack view --json",
      "stack link --base main -- feature",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci distinguishes submit restoration failure from link failure", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "origin", "main", "feature"]);
    git(cwd, ["branch", "other"]);

    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      assert.equal(args[1], "submit");
      git(cwd, ["switch", "other"]);
      return { stdout: "submitted", stderr: "" };
    };
    let readinessCalled = false;
    const tool = requireTool(
      registeredTools({
        stackRunner,
        restoreBranch: async () => ({ success: false, output: "restore failed" }),
        stackReadinessRunner: async () => {
          readinessCalled = true;
          throw new Error("readiness must not run after submit restoration failure");
        },
      }),
      "push_and_check_ci",
    );

    const result = await tool.execute("submit-restoration-failure", {}, undefined, undefined, {
      cwd,
    });

    assert.equal(result.details.stackSubmitSucceeded, true);
    assert.equal(result.details.stackSubmitRestorationFailed, true);
    assert.equal(result.details.stackLinkFailed, undefined);
    assert.equal(result.details.remoteStackLinkFailed, undefined);
    assert.equal(result.details.stackLinkAttempted, false);
    assert.equal(result.details.remoteStackLinked, false);
    assert.equal(result.details.stackLinkOutput, undefined);
    assert.equal(readinessCalled, false);
    assert.deepEqual(calls, ["stack view --json", "stack sync", "stack submit --auto"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("push_and_check_ci stops before readiness when remote stack linking fails", async () => {
  const cwd = createRepository();
  const remote = mkdtempSync(join(tmpdir(), "github-stack-origin-"));
  try {
    git(remote, ["init", "--bare"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "origin", "main", "feature"]);
    git(cwd, ["branch", "other"]);

    const calls: string[] = [];
    const stackRunner: GhStackCommandRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[1] === "view") {
        return { stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}', stderr: "" };
      }
      if (args[1] === "sync") return { stdout: "synced", stderr: "" };
      if (args[1] === "submit") return { stdout: "submitted", stderr: "" };
      assert.deepEqual(args, ["stack", "link", "--base", "main", "--", "feature"]);
      git(cwd, ["switch", "other"]);
      throw new Error("remote link failed");
    };
    let readinessCalled = false;
    const stackReadinessRunner: StackReadinessRunner = async () => {
      readinessCalled = true;
      throw new Error("readiness must not run after link failure");
    };
    const tool = requireTool(
      registeredTools({ stackRunner, stackReadinessRunner }),
      "push_and_check_ci",
    );

    const result = await tool.execute("link-failure", {}, undefined, undefined, { cwd });

    assert.equal(result.details.stackSubmitSucceeded, true);
    assert.equal(result.details.stackLinkFailed, true);
    assert.equal(result.details.remoteStackLinkFailed, true);
    assert.equal(result.details.stackLinkAttempted, true);
    assert.equal(result.details.stackLinkSucceeded, false);
    assert.equal(result.details.remoteStackLinked, false);
    assert.equal(result.details.workspaceRestored, true);
    assert.equal(result.details.stackLinkOutput, "remote link failed");
    assert.equal(readinessCalled, false);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.deepEqual(calls, [
      "stack view --json",
      "stack sync",
      "stack submit --auto",
      "stack view --json",
      "stack link --base main -- feature",
    ]);
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

test("inspect_stack enriches remote PR details without mutating local state", async () => {
  const cwd = createRepository();
  try {
    git(cwd, ["branch", "middle", "main"]);
    const members = [
      { branch: "main", pr: { number: 11 } },
      { branch: "middle", pr: { number: 12 } },
      { branch: "feature", pr: { number: 13 } },
    ];
    const remote = remoteStack(
      members.map((member) => ({
        number: member.pr.number,
        branch: member.branch,
        sha: git(cwd, ["rev-parse", member.branch]),
        state: member.branch === "middle" ? "CLOSED" : "OPEN",
        draft: member.branch !== "middle",
      })),
    );
    const fixture = stackFixture(cwd, members, { remote });
    const ownership = controllerFixture({
      activeBranch: "feature",
      branches: ["main", "middle", "feature"],
      baseBranch: "main",
    });
    const beforeBranch = git(cwd, ["branch", "--show-current"]);
    const beforeHead = git(cwd, ["rev-parse", "HEAD"]);
    const result = await requireTool(
      registeredTools({ stackRunner: fixture.runner, workspaceController: ownership.controller }),
      "inspect_stack",
    ).execute("inspect", {}, undefined, undefined, { cwd });

    const local = result.details.local as { members: Array<Record<string, unknown>> };
    assert.equal(result.details.status, "synchronized");
    assert.equal((result.details.remote as { status: string }).status, "synchronized");
    assert.equal((result.details.ownership as { status: string }).status, "synchronized");
    assert.equal(local.members[1].state, "CLOSED");
    assert.equal(local.members[1].draft, false);
    assert.equal(local.members[1].sha, git(cwd, ["rev-parse", "middle"]));
    assert.equal(local.members[1].remoteSha, git(cwd, ["rev-parse", "middle"]));
    assert.equal(local.members[1].shaMismatch, false);
    assert.deepEqual(ownership.calls, ["snapshot"]);
    assert.equal(git(cwd, ["branch", "--show-current"]), beforeBranch);
    assert.equal(git(cwd, ["rev-parse", "HEAD"]), beforeHead);

    const mismatchRemote = remoteStack([
      { number: 11, branch: "main", sha: "remote-main" },
      { number: 12, branch: "middle", sha: "remote-middle" },
      { number: 13, branch: "feature", sha: "remote-feature" },
    ]);
    const mismatchFixture = stackFixture(cwd, members, { remote: mismatchRemote });
    const mismatch = await requireTool(
      registeredTools({ stackRunner: mismatchFixture.runner }),
      "inspect_stack",
    ).execute("inspect-mismatch", {}, undefined, undefined, { cwd });
    const mismatchMember = (mismatch.details.local as { members: Array<Record<string, unknown>> })
      .members[1];
    assert.equal(mismatch.details.status, "mismatch");
    assert.equal(mismatchMember.shaMismatch, true);
    assert.equal(mismatchMember.remoteSha, "remote-middle");
    assert.match(mismatch.content?.[0]?.text ?? "", /SHA mismatch/);

    const localOnlyFixture = stackFixture(cwd, [{ branch: "main" }, { branch: "feature" }]);
    const localOnly = await requireTool(
      registeredTools({ stackRunner: localOnlyFixture.runner }),
      "inspect_stack",
    ).execute("inspect-local-only", {}, undefined, undefined, { cwd });
    assert.equal(
      localOnly.details.remote && (localOnly.details.remote as { status: string }).status,
      "local-only",
    );
    assert.equal(git(cwd, ["branch", "--show-current"]), beforeBranch);
    assert.equal(git(cwd, ["rev-parse", "HEAD"]), beforeHead);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkout_stack_branch adopts exact and PR-selected members with descendants", async () => {
  const cwd = createRepository();
  try {
    git(cwd, ["branch", "middle", "main"]);
    const members = [
      { branch: "main", pr: { number: 21 } },
      { branch: "middle", pr: { number: 22 } },
      { branch: "feature", pr: { number: 23 } },
    ];
    const fixture = stackFixture(cwd, members);
    const claims: unknown[] = [];
    const controller: WorkspaceController = {
      snapshot: async () => ({
        activeBranch: "feature",
        branches: ["main", "middle", "feature"],
        baseBranch: "main",
      }),
      validate: async (_cwd, claim) => claims.push({ phase: "validate", claim }),
      claim: async (_cwd, claim) => claims.push({ phase: "claim", claim }),
      restore: async () => {},
    };
    const tool = requireTool(
      registeredTools({ stackRunner: fixture.runner, workspaceController: controller }),
      "checkout_stack_branch",
    );
    const exact = await tool.execute(
      "checkout-middle",
      { target: "middle" },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(exact.details.checkoutSucceeded, true, JSON.stringify(exact));
    assert.equal(exact.details.activeBranch, "middle");
    assert.deepEqual(exact.details.descendants, ["feature"]);
    assert.equal(git(cwd, ["branch", "--show-current"]), "middle");

    const selected = await tool.execute("checkout-pr", { target: "#23" }, undefined, undefined, {
      cwd,
    });
    assert.equal(selected.details.checkoutSucceeded, true);
    assert.equal(selected.details.activeBranch, "feature");
    assert.deepEqual(selected.details.descendants, []);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
    assert.equal(
      (claims as Array<{ phase: string }>).filter((entry) => entry.phase === "claim").length,
      2,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkout_stack_branch rejects dirty and nonmember targets without checkout or claim", async () => {
  const cwd = createRepository();
  try {
    const fixture = stackFixture(cwd, [
      { branch: "main", pr: { number: 31 } },
      { branch: "feature", pr: { number: 32 } },
    ]);
    const calls: string[] = [];
    const controller: WorkspaceController = {
      snapshot: async () => ({
        activeBranch: "feature",
        branches: ["main", "feature"],
        baseBranch: "main",
      }),
      validate: async () => calls.push("validate"),
      claim: async () => calls.push("claim"),
      restore: async () => {},
    };
    const tool = requireTool(
      registeredTools({ stackRunner: fixture.runner, workspaceController: controller }),
      "checkout_stack_branch",
    );
    writeFileSync(join(cwd, "dirty.txt"), "dirty\n");
    const dirty = await tool.execute("dirty", { target: "main" }, undefined, undefined, { cwd });
    assert.equal(dirty.details.dirtyWorkingTree, true);
    git(cwd, ["clean", "-fd"]);
    const nonmember = await tool.execute("nonmember", { target: "999" }, undefined, undefined, {
      cwd,
    });
    assert.equal(nonmember.details.invalidTarget, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(fixture.calls, ["stack view --json"]);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkout_stack_branch restores after traversal failure and does not pass the caller signal", async () => {
  const cwd = createRepository();
  try {
    const fixture = stackFixture(
      cwd,
      [
        { branch: "main", pr: { number: 41 } },
        { branch: "feature", pr: { number: 42 } },
      ],
      {
        checkout: () => {
          throw new Error("traversal failed");
        },
      },
    );
    const restoreSignals: (AbortSignal | undefined)[] = [];
    const controller: WorkspaceController = {
      snapshot: async () => ({
        activeBranch: "feature",
        branches: ["main", "feature"],
        baseBranch: "main",
      }),
      validate: async () => {},
      claim: async () => {
        throw new Error("claim must not run");
      },
      restore: async () => {},
    };
    const result = await requireTool(
      registeredTools({
        stackRunner: fixture.runner,
        workspaceController: controller,
        restoreBranch: async (_cwd, branch, signal) => {
          restoreSignals.push(signal);
          git(cwd, ["switch", "--", branch]);
          return { success: true, output: "restored" };
        },
      }),
      "checkout_stack_branch",
    ).execute("traverse-failure", { target: "main" }, new AbortController().signal, undefined, {
      cwd,
    });
    assert.equal(result.details.checkoutFailed, true);
    assert.equal(result.details.claimFailed, undefined);
    assert.deepEqual(restoreSignals, [undefined]);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkout_stack_branch restores after claim failure without reporting success", async () => {
  const cwd = createRepository();
  try {
    const fixture = stackFixture(cwd, [
      { branch: "main", pr: { number: 51 } },
      { branch: "feature", pr: { number: 52 } },
    ]);
    const restoreSignals: (AbortSignal | undefined)[] = [];
    const result = await requireTool(
      registeredTools({
        stackRunner: fixture.runner,
        workspaceController: {
          snapshot: async () => ({
            activeBranch: "feature",
            branches: ["main", "feature"],
            baseBranch: "main",
          }),
          validate: async () => {},
          claim: async () => {
            throw new Error("registry is read-only");
          },
          restore: async () => {},
        },
        restoreBranch: async (_cwd, branch, signal) => {
          restoreSignals.push(signal);
          git(cwd, ["switch", "--", branch]);
          return { success: true, output: "restored" };
        },
      }),
      "checkout_stack_branch",
    ).execute("claim-failure", { target: "main" }, undefined, undefined, { cwd });
    assert.equal(result.details.claimFailed, true);
    assert.equal(result.details.checkoutSucceeded, undefined);
    assert.deepEqual(restoreSignals, [undefined]);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkout_stack_branch cancels after checkout, restores signal-free, and skips claim", async () => {
  const cwd = createRepository();
  try {
    const cancellation = new AbortController();
    const fixture = stackFixture(
      cwd,
      [
        { branch: "main", pr: { number: 61 } },
        { branch: "feature", pr: { number: 62 } },
      ],
      {
        checkout: (_branch, signal) => {
          cancellation.abort();
          assert.equal(signal, cancellation.signal);
        },
      },
    );
    const calls: string[] = [];
    const result = await requireTool(
      registeredTools({
        stackRunner: fixture.runner,
        workspaceController: {
          snapshot: async () => ({
            activeBranch: "feature",
            branches: ["main", "feature"],
            baseBranch: "main",
          }),
          validate: async () => {},
          claim: async () => calls.push("claim"),
          restore: async () => {},
        },
        restoreBranch: async (_cwd, branch, signal) => {
          calls.push(`restore:${signal === undefined ? "signal-free" : "signalled"}`);
          git(cwd, ["switch", "--", branch]);
          return { success: true, output: "restored" };
        },
      }),
      "checkout_stack_branch",
    ).execute("cancel", { target: "main" }, cancellation.signal, undefined, { cwd });
    assert.equal(result.details.cancelled, true);
    assert.deepEqual(calls, ["restore:signal-free"]);
    assert.equal(git(cwd, ["branch", "--show-current"]), "feature");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkout_stack_branch rejects an unknown base before validation", async () => {
  const cwd = createRepository();
  try {
    const calls: string[] = [];
    const runner: GhStackCommandRunner = async (args) => {
      assert.deepEqual(args, ["stack", "view", "--json"]);
      return {
        stdout: JSON.stringify({
          currentBranch: "feature",
          branches: [
            {
              name: "main",
              isCurrent: false,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
            {
              name: "feature",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
          ],
        }),
        stderr: "",
      };
    };
    const result = await requireTool(
      registeredTools({
        stackRunner: runner,
        workspaceController: {
          snapshot: async () => ({
            activeBranch: "feature",
            branches: ["main", "feature"],
            baseBranch: null,
          }),
          validate: async () => calls.push("validate"),
          claim: async () => calls.push("claim"),
          restore: async () => {},
        },
      }),
      "checkout_stack_branch",
    ).execute("unknown-base", { target: "feature" }, undefined, undefined, { cwd });
    assert.equal(result.details.invalidStackMetadata, true);
    assert.deepEqual(calls, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkout_stack_branch cancels during validation on a no-op target without claiming", async () => {
  const cwd = createRepository();
  try {
    const cancellation = new AbortController();
    const calls: string[] = [];
    const fixture = stackFixture(cwd, [
      { branch: "main", pr: { number: 71 } },
      { branch: "feature", pr: { number: 72 } },
    ]);
    const result = await requireTool(
      registeredTools({
        stackRunner: fixture.runner,
        workspaceController: {
          snapshot: async () => ({
            activeBranch: "feature",
            branches: ["main", "feature"],
            baseBranch: "main",
          }),
          validate: async () => cancellation.abort(),
          claim: async () => calls.push("claim"),
          restore: async () => calls.push("restore"),
        },
      }),
      "checkout_stack_branch",
    ).execute("cancel-no-op", { target: "feature" }, cancellation.signal, undefined, { cwd });
    assert.equal(result.details.cancelled, true);
    assert.deepEqual(calls, ["restore"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkout_stack_branch restores branch and workspace after post-claim assertion failure", async () => {
  const cwd = createRepository();
  try {
    const fixture = stackFixture(cwd, [
      { branch: "main", pr: { number: 81 } },
      { branch: "feature", pr: { number: 82 } },
    ]);
    let assertions = 0;
    const calls: string[] = [];
    const result = await requireTool(
      registeredTools({
        stackRunner: fixture.runner,
        assertWorkspace: async () => {
          assertions++;
          if (assertions > 1) throw new Error("workspace assertion failed");
        },
        workspaceController: {
          snapshot: async () => ({
            activeBranch: "feature",
            branches: ["main", "feature"],
            baseBranch: "main",
          }),
          validate: async () => {},
          claim: async () => calls.push("claim"),
          restore: async () => calls.push("restore"),
        },
        restoreBranch: async (_cwd, branch) => {
          calls.push(`branch:${branch}`);
          git(cwd, ["switch", "--", branch]);
          return { success: true, output: "restored" };
        },
      }),
      "checkout_stack_branch",
    ).execute("assert-failure", { target: "main" }, undefined, undefined, { cwd });
    assert.equal(result.details.assertWorkspaceFailed, true);
    assert.equal(result.details.claimSucceeded, true);
    assert.equal(result.details.rolledBack, true);
    assert.equal(result.details.workspaceRolledBack, true);
    assert.deepEqual(calls, ["claim", "branch:feature", "restore"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkout_stack_branch reports structured rollback failure when branch restore rejects", async () => {
  const cwd = createRepository();
  try {
    const fixture = stackFixture(cwd, [
      { branch: "main", pr: { number: 91 } },
      { branch: "feature", pr: { number: 92 } },
    ]);
    const result = await requireTool(
      registeredTools({
        stackRunner: fixture.runner,
        workspaceController: {
          snapshot: async () => ({
            activeBranch: "feature",
            branches: ["main", "feature"],
            baseBranch: "main",
          }),
          validate: async () => {},
          claim: async () => {
            throw new Error("claim rejected");
          },
          restore: async () => {},
        },
        restoreBranch: async () => {
          throw new Error("restore rejected");
        },
      }),
      "checkout_stack_branch",
    ).execute("restore-rejection", { target: "main" }, undefined, undefined, { cwd });
    assert.equal(result.details.claimFailed, true);
    assert.equal(result.details.rolledBack, false);
    assert.equal(result.details.rollbackRestoreFailed, true);
    assert.equal(result.details.workspaceRolledBack, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inspect_stack reports partial aggregate status without a workspace controller", async () => {
  const cwd = createRepository();
  try {
    const members = [
      { branch: "main", pr: { number: 101 } },
      { branch: "feature", pr: { number: 102 } },
    ];
    const fixture = stackFixture(cwd, members, {
      remote: remoteStack(
        members.map((member) => ({
          number: member.pr.number,
          branch: member.branch,
          sha: git(cwd, ["rev-parse", member.branch]),
        })),
      ),
    });
    const result = await requireTool(
      registeredTools({ stackRunner: fixture.runner }),
      "inspect_stack",
    ).execute("partial", {}, undefined, undefined, { cwd });
    assert.equal(result.details.status, "partial");
    assert.equal((result.details.remote as { status: string }).status, "synchronized");
    assert.equal((result.details.ownership as { status: string }).status, "unavailable");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inspect_stack reports enriched local head mismatch", async () => {
  const cwd = createRepository();
  try {
    const fixture = stackFixture(cwd, [
      { branch: "main", head: "wrong-main" },
      { branch: "feature" },
    ]);
    const result = await requireTool(
      registeredTools({ stackRunner: fixture.runner }),
      "inspect_stack",
    ).execute("head-mismatch", {}, undefined, undefined, { cwd });
    const member = (result.details.local as { members: Array<Record<string, unknown>> }).members[0];
    assert.equal(member.localHeadMismatch, true);
    assert.equal(member.localHeadVerification, "mismatch");
    assert.equal(result.details.status, "mismatch");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inspect_stack marks omitted enriched heads unavailable rather than mismatched", async () => {
  const cwd = createRepository();
  try {
    const fixture = stackFixture(cwd, [
      { branch: "main", head: null },
      { branch: "feature", head: null },
    ]);
    const result = await requireTool(
      registeredTools({ stackRunner: fixture.runner }),
      "inspect_stack",
    ).execute("head-unavailable", {}, undefined, undefined, { cwd });
    const members = (result.details.local as { members: Array<Record<string, unknown>> }).members;
    assert.equal(members[0].localHeadVerification, "unavailable");
    assert.equal(members[0].localHeadMismatch, false);
    assert.equal((result.details.local as { status: string }).status, "partial");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
