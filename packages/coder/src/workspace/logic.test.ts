import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertManagedWorkspace,
  assertOwnedWorkspace,
  assertWorkspacePath,
  claimWorkspaceStack,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  loadWorkspace,
  removeWorkspaceWorktree,
  replaceWorkspaceOwnership,
  resolveRegularCheckout,
  resolveRepository,
  updateWorkspace,
  workspaceBranches,
  workspaceOwnsBranch,
  type WorkspaceStore,
} from "./logic.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repositoryLockPath(store: WorkspaceStore, repository: string): string {
  const key = createHash("sha256").update(repository).digest("hex");
  return join(store.stateDir, "workspaces", "locks", `${key}.lock`);
}

function fixture(): {
  root: string;
  repo: string;
  store: WorkspaceStore;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-workspace-test-"));
  const repo = join(root, "repo");
  const store = { stateDir: join(root, "state") };
  execFileSync("git", ["init", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "Initial commit");
  return { root, repo, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("legacy workspaces expose their active branch as their only owned branch", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/legacy");
    assert.deepEqual(workspaceBranches(workspace), [workspace.branch]);
    assert.equal(workspaceOwnsBranch(workspace, workspace.branch), true);
    assert.equal(workspaceOwnsBranch(workspace, "feature/other"), false);
  } finally {
    cleanup();
  }
});

test("claims valid stack metadata and rejects overlap with another workspace", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const first = await createWorkspace(store, repo, "feature/stack-tip");
    const second = await createWorkspace(store, repo, "feature/other");
    const stacked = await claimWorkspaceStack(store, first, {
      baseBranch: "main",
      branches: ["feature/base", first.branch],
    });
    assert.deepEqual(stacked.stack, {
      baseBranch: "main",
      branches: ["feature/base", first.branch],
    });
    assert.equal(workspaceOwnsBranch(stacked, "feature/base"), true);
    git(repo, "branch", "feature/base");
    git(first.worktree, "switch", "feature/base");
    const moved = await claimWorkspaceStack(store, stacked, stacked.stack!, "feature/base");
    assert.equal(moved.branch, "feature/base");
    await assertOwnedWorkspace(moved);
    await assert.rejects(
      claimWorkspaceStack(store, second, {
        baseBranch: "main",
        branches: [second.branch, first.branch],
      }),
      /already owned by another workspace/,
    );
    await assert.rejects(
      claimWorkspaceStack(store, second, { baseBranch: "", branches: [second.branch] }),
      /Invalid workspace stack metadata/,
    );
    await assert.rejects(
      claimWorkspaceStack(store, second, {
        baseBranch: "main",
        branches: [second.branch, second.branch],
      }),
      /Invalid workspace stack metadata/,
    );
    await assert.rejects(
      claimWorkspaceStack(store, second, { baseBranch: "main", branches: ["feature/not-active"] }),
      /Invalid workspace record/,
    );
  } finally {
    cleanup();
  }
});

test("stale updates preserve a stack claim written after the stale object", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/stale-update");
    await claimWorkspaceStack(store, workspace, {
      baseBranch: "main",
      branches: [workspace.branch, "feature/stale-base"],
    });

    await updateWorkspace(store, workspace, { sessionName: "updated from stale state" });

    const current = await loadWorkspace(store, workspace.id);
    assert.deepEqual(current.stack, {
      baseBranch: "main",
      branches: [workspace.branch, "feature/stale-base"],
    });
    assert.equal(current.sessionName, "updated from stale state");
  } finally {
    cleanup();
  }
});

test("concurrent overlapping stack claims have exactly one success", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const first = await createWorkspace(store, repo, "feature/concurrent-first");
    const second = await createWorkspace(store, repo, "feature/concurrent-second");
    const outcomes = await Promise.allSettled([
      claimWorkspaceStack(store, first, {
        baseBranch: "main",
        branches: [first.branch, "feature/concurrent-shared"],
      }),
      claimWorkspaceStack(store, second, {
        baseBranch: "main",
        branches: [second.branch, "feature/concurrent-shared"],
      }),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (!rejected || rejected.status !== "rejected") throw new Error("Expected a rejected claim.");
    assert.match(
      rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason),
      /already owned by another workspace/,
    );
  } finally {
    cleanup();
  }
});

test("creates an isolated branch and worktree without moving dirty source changes", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "tracked.txt"), "dirty source checkout\n");
    const originalBranch = git(repo, "branch", "--show-current");

    const workspace = await createWorkspace(store, repo, "feature/parser");

    assert.equal(git(repo, "branch", "--show-current"), originalBranch);
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "dirty source checkout\n");
    assert.equal(readFileSync(join(workspace.worktree, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(git(workspace.worktree, "branch", "--show-current"), workspace.branch);
    assert.equal(workspace.branch, "feature/parser");
    assert.equal(workspace.branchSetup, "created");
    assert.equal(workspace.baseSha, git(repo, "rev-parse", "HEAD"));
    await assertOwnedWorkspace(workspace);
  } finally {
    cleanup();
  }
});

test("resolves the regular checkout from a managed worktree", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/regular-checkout");
    const repository = await resolveRepository(repo);

    assert.equal(await resolveRegularCheckout(workspace.worktree), repository.sourceRoot);
  } finally {
    cleanup();
  }
});

test("lists repository workspaces and persists session metadata", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const first = await createWorkspace(store, repo, "feature/one", {
      transition: {
        phase: "pending",
        sourceSessionFile: "/sessions/source.jsonl",
      },
    });
    assert.deepEqual((await loadWorkspace(store, first.id)).transition, first.transition);
    const second = await createWorkspace(store, repo, "feature/two");
    const updated = await updateWorkspace(store, first, {
      sessionFile: "/sessions/one.jsonl",
      sessionName: "Refactor auth",
      transition: {
        phase: "switching",
        sourceSessionFile: "/sessions/source.jsonl",
        targetSessionFile: "/sessions/one-target.jsonl",
      },
    });
    const repository = await resolveRepository(repo);

    const loaded = await loadWorkspace(store, updated.id);
    assert.deepEqual(loaded, updated);

    const records = await listWorkspaces(store, repository.repository);

    assert.equal(records.length, 2);
    const persisted = records.find((record) => record.id === updated.id);
    assert.equal(persisted?.sessionFile, "/sessions/one.jsonl");
    assert.equal(persisted?.sessionName, "Refactor auth");
    assert.deepEqual(persisted?.transition, updated.transition);
    assert.ok(records.some((record) => record.id === second.id));
  } finally {
    cleanup();
  }
});

test("rejects malformed transition metadata in a workspace record", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const created = await createWorkspace(store, repo, "feature/malformed-transition");
    const path = join(store.stateDir, "workspaces", "records", `${created.id}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        ...created,
        transition: { phase: "switching", targetSessionFile: "/sessions/target.jsonl" },
      }),
    );

    await assert.rejects(loadWorkspace(store, created.id), /Invalid workspace record/);
    await assert.rejects(listWorkspaces(store, created.repository), /Invalid workspace record/);
  } finally {
    cleanup();
  }
});

test("deletes only the requested workspace record", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const first = await createWorkspace(store, repo, "feature/delete-one");
    const second = await createWorkspace(store, repo, "feature/keep-two");
    const repository = await resolveRepository(repo);

    await deleteWorkspace(store, first.id);
    await deleteWorkspace(store, first.id);

    assert.deepEqual(
      (await listWorkspaces(store, repository.repository)).map((record) => record.id),
      [second.id],
    );
  } finally {
    cleanup();
  }
});

test("recovers a lock file owned by a dead PID", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/dead-lock");
    const lockPath = repositoryLockPath(store, workspace.repository);
    const child = spawn(process.execPath, ["-e", ""]);
    const deadPid = child.pid;
    if (deadPid === undefined) throw new Error("Could not start a lock-owner fixture process.");
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: "abandoned" }));

    const updated = await updateWorkspace(store, workspace, { sessionName: "recovered" });

    assert.equal(updated.sessionName, "recovered");
  } finally {
    cleanup();
  }
});

test("times out within a bounded interval for a live workspace lock", async () => {
  const { repo, store, cleanup } = fixture();
  let lockPath: string | undefined;
  try {
    const workspace = await createWorkspace(store, repo, "feature/live-lock");
    lockPath = repositoryLockPath(store, workspace.repository);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "held" }));
    const startedAt = Date.now();

    await assert.rejects(
      updateWorkspace(store, workspace, { sessionName: "blocked" }),
      /Timed out waiting for the workspace registry lock/,
    );

    assert.ok(Date.now() - startedAt < 3_000);
  } finally {
    if (lockPath) rmSync(lockPath, { recursive: true, force: true });
    cleanup();
  }
});

test("ignores an orphaned incomplete owner temp file", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/orphaned-lock-temp");
    const lockPath = repositoryLockPath(store, workspace.repository);
    const temporaryOwner = join(dirname(lockPath), ".lock-owner-crash-window.tmp");
    writeFileSync(temporaryOwner, '{"pid":');

    const updated = await updateWorkspace(store, workspace, { sessionName: "not blocked" });

    assert.equal(updated.sessionName, "not blocked");
    assert.equal(readFileSync(temporaryOwner, "utf8"), '{"pid":');
  } finally {
    cleanup();
  }
});

test("legacy ownership restore rejects overlap without overwriting the current record", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const first = await createWorkspace(store, repo, "feature/restore-first");
    const second = await createWorkspace(store, repo, "feature/restore-second");
    const stacked = await claimWorkspaceStack(store, first, {
      baseBranch: "main",
      branches: [first.branch, "feature/restore-base"],
    });

    await assert.rejects(
      replaceWorkspaceOwnership(store, stacked, { branch: second.branch }),
      /already owned by another workspace/,
    );

    assert.deepEqual(await loadWorkspace(store, first.id), stacked);
  } finally {
    cleanup();
  }
});

test("removes a clean managed worktree normally", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/remove-clean");

    assert.equal(await removeWorkspaceWorktree(store, workspace, repo), true);
    assert.throws(() => readFileSync(join(workspace.worktree, "tracked.txt")), /ENOENT/);
  } finally {
    cleanup();
  }
});

test("rejects dirty managed worktrees before removal", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/retain-dirty");
    writeFileSync(join(workspace.worktree, "tracked.txt"), "dirty\n");

    await assert.rejects(removeWorkspaceWorktree(store, workspace, repo), /uncommitted changes/);
    assert.equal(readFileSync(join(workspace.worktree, "tracked.txt"), "utf8"), "dirty\n");
  } finally {
    cleanup();
  }
});

test("treats an already-missing managed worktree as removed", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/remove-retry");
    git(repo, "worktree", "remove", workspace.worktree);

    assert.equal(await removeWorkspaceWorktree(store, workspace, repo), false);
  } finally {
    cleanup();
  }
});

test("creates a workspace from an available local branch", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const branch = "feature/existing-local";
    git(repo, "branch", branch);

    const workspace = await createWorkspace(store, repo, branch);

    assert.equal(workspace.branchSetup, "reused-local");
    assert.equal(git(workspace.worktree, "branch", "--show-current"), branch);
    assert.equal(workspace.baseSha, git(repo, "rev-parse", branch));
  } finally {
    cleanup();
  }
});

test("reports when an existing local branch is already checked out", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const branch = git(repo, "branch", "--show-current");

    await assert.rejects(
      createWorkspace(store, repo, branch),
      new RegExp(
        `Cannot create agent workspace from local branch ${branch}\\. ` +
          `It may already be checked out[\\s\\S]*already used by worktree`,
      ),
    );
  } finally {
    cleanup();
  }
});

test("fetches an existing remote branch into a new workspace", async () => {
  const { root, repo, store, cleanup } = fixture();
  try {
    const remote = join(root, "remote.git");
    const branch = "feature/existing-remote";
    execFileSync("git", ["init", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "branch", branch);
    git(repo, "push", "origin", `${branch}:${branch}`);
    git(repo, "branch", "-D", branch);

    const workspace = await createWorkspace(store, repo, branch);

    assert.equal(workspace.branchSetup, "fetched-origin");
    assert.equal(git(workspace.worktree, "branch", "--show-current"), branch);
    assert.equal(
      git(workspace.worktree, "rev-parse", "--abbrev-ref", "@{upstream}"),
      `origin/${branch}`,
    );
    assert.equal(workspace.baseSha, git(repo, "rev-parse", `origin/${branch}`));
  } finally {
    cleanup();
  }
});

test("rejects a command cwd outside the launch directory", async () => {
  const { root, repo, cleanup } = fixture();
  try {
    await assert.rejects(assertWorkspacePath(repo, root), /path mismatch/);
  } finally {
    cleanup();
  }
});

test("rejects a command cwd outside the owned worktree", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/owned");

    await assert.rejects(assertOwnedWorkspace(workspace, repo), /path mismatch/);
  } finally {
    cleanup();
  }
});

test("validates an explicit managed checkout branch without persisted ownership", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/managed");
    git(repo, "branch", "feature/adopted");
    git(workspace.worktree, "switch", "feature/adopted");

    await assertManagedWorkspace(workspace, workspace.worktree, "feature/adopted");
    await assert.rejects(assertOwnedWorkspace(workspace), /branch mismatch/);
  } finally {
    cleanup();
  }
});

test("rejects a workspace checked out on a branch it does not own", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/detach");
    git(workspace.worktree, "checkout", "--detach");

    await assert.rejects(assertOwnedWorkspace(workspace), /branch mismatch|symbolic-ref/);
  } finally {
    cleanup();
  }
});
