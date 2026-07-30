import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionPointerStore } from "../session-pointer.ts";
import {
  createWorkspace,
  listWorkspaces,
  resolveRepository,
  updateWorkspace,
  type AgentWorkspace,
  type WorkspaceStore,
} from "./logic.ts";
import {
  reconcileMergedWorkspaces,
  removeWorkspaceByBranch,
  type MergedPullRequest,
} from "./reconcile.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(root: string, name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "Initial commit");
  return repo;
}

function fixture(): {
  root: string;
  repo: string;
  store: WorkspaceStore;
  pointers: ReturnType<typeof createSessionPointerStore>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "workspace-reconcile-"));
  const store = { stateDir: join(root, "state") };
  return {
    root,
    repo: createRepository(root, "repo"),
    store,
    pointers: createSessionPointerStore(store.stateDir),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function attachSession(
  store: WorkspaceStore,
  pointers: ReturnType<typeof createSessionPointerStore>,
  workspace: AgentWorkspace,
  root: string,
): Promise<AgentWorkspace> {
  const sessionFile = join(root, `${workspace.id}.jsonl`);
  writeFileSync(sessionFile, "session\n");
  await pointers.write(workspace.worktree, sessionFile);
  return updateWorkspace(store, workspace, { sessionFile });
}

function merged(number = 17, headSha?: string) {
  return async (_cwd: string, _branch: string, localHead: string): Promise<MergedPullRequest> => ({
    number,
    headSha: headSha ?? localHead,
  });
}

async function records(store: WorkspaceStore, repo: string): Promise<AgentWorkspace[]> {
  const repository = await resolveRepository(repo);
  return listWorkspaces(store, repository.repository);
}

test("removes every artifact for a clean merged workspace", async () => {
  const { root, repo, store, pointers, cleanup } = fixture();
  try {
    const workspace = await attachSession(
      store,
      pointers,
      await createWorkspace(store, repo, "feature/merged"),
      root,
    );

    const result = await reconcileMergedWorkspaces({
      store,
      cwd: repo,
      sessionPointers: pointers,
      findMergedPullRequest: merged(),
    });

    assert.deepEqual(result.removed, [
      { workspaceId: workspace.id, branch: workspace.branch, prNumber: 17 },
    ]);
    assert.equal(existsSync(workspace.worktree), false);
    assert.equal(existsSync(workspace.sessionFile!), false);
    assert.equal(await pointers.read(workspace.worktree), undefined);
    assert.deepEqual(await records(store, repo), []);
  } finally {
    cleanup();
  }
});

test("removes every artifact for an explicitly deleted branch workspace", async () => {
  const { root, repo, store, pointers, cleanup } = fixture();
  try {
    const workspace = await attachSession(
      store,
      pointers,
      await createWorkspace(store, repo, "feature/delete"),
      root,
    );

    const removed = await removeWorkspaceByBranch(
      { store, cwd: repo, sessionPointers: pointers },
      workspace.branch,
    );

    assert.deepEqual(removed, { workspaceId: workspace.id, branch: workspace.branch });
    assert.equal(existsSync(workspace.worktree), false);
    assert.equal(existsSync(workspace.sessionFile!), false);
    assert.equal(await pointers.read(workspace.worktree), undefined);
    assert.deepEqual(await records(store, repo), []);
    assert.equal(
      git(repo, "show-ref", "--verify", `refs/heads/${workspace.branch}`).length > 0,
      true,
    );
  } finally {
    cleanup();
  }
});

test("cleans up an active workspace whose managed worktree is missing", async () => {
  const { root, repo, store, pointers, cleanup } = fixture();
  try {
    const workspace = await attachSession(
      store,
      pointers,
      await createWorkspace(store, repo, "feature/missing"),
      root,
    );
    rmSync(workspace.worktree, { recursive: true });

    const result = await reconcileMergedWorkspaces({
      store,
      cwd: repo,
      sessionPointers: pointers,
      findMergedPullRequest: async () => {
        throw new Error("pull request lookup should not run");
      },
    });

    assert.deepEqual(result.removed, [{ workspaceId: workspace.id, branch: workspace.branch }]);
    assert.equal(existsSync(workspace.sessionFile!), false);
    assert.equal(await pointers.read(workspace.worktree), undefined);
    assert.deepEqual(await records(store, repo), []);
    const worktreeList = git(repo, "worktree", "list", "--porcelain");
    assert.equal(worktreeList.includes(workspace.worktree), false, worktreeList);
    assert.equal(
      git(repo, "show-ref", "--verify", `refs/heads/${workspace.branch}`).length > 0,
      true,
    );
  } finally {
    cleanup();
  }
});

test("retains a workspace without a merged pull request", async () => {
  const { root, repo, store, pointers, cleanup } = fixture();
  try {
    const workspace = await attachSession(
      store,
      pointers,
      await createWorkspace(store, repo, "feature/open"),
      root,
    );

    const result = await reconcileMergedWorkspaces({
      store,
      cwd: repo,
      sessionPointers: pointers,
      findMergedPullRequest: async () => null,
    });

    assert.equal(result.retained[0]?.reason, "no merged pull request");
    assert.equal(existsSync(workspace.worktree), true);
    assert.equal(existsSync(workspace.sessionFile!), true);
    assert.equal(await pointers.read(workspace.worktree), workspace.sessionFile);
    assert.equal((await records(store, repo))[0]?.status, "active");
  } finally {
    cleanup();
  }
});

test("retains a dirty merged workspace and all of its session state", async () => {
  const { root, repo, store, pointers, cleanup } = fixture();
  try {
    const workspace = await attachSession(
      store,
      pointers,
      await createWorkspace(store, repo, "feature/dirty"),
      root,
    );
    writeFileSync(join(workspace.worktree, "tracked.txt"), "dirty\n");

    const result = await reconcileMergedWorkspaces({
      store,
      cwd: repo,
      sessionPointers: pointers,
      findMergedPullRequest: merged(),
    });

    assert.match(result.retained[0]?.reason ?? "", /uncommitted changes/);
    assert.equal(result.retained[0]?.actionable, true);
    assert.equal(existsSync(workspace.sessionFile!), true);
    assert.equal(await pointers.read(workspace.worktree), workspace.sessionFile);
    assert.equal((await records(store, repo))[0]?.status, "active");
  } finally {
    cleanup();
  }
});

test("retains a workspace when the merged pull request has a different head", async () => {
  const { repo, store, pointers, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/advanced");

    const result = await reconcileMergedWorkspaces({
      store,
      cwd: repo,
      sessionPointers: pointers,
      findMergedPullRequest: merged(18, "different-sha"),
    });

    assert.match(result.retained[0]?.reason ?? "", /differs/);
    assert.equal(existsSync(workspace.worktree), true);
    assert.equal((await records(store, repo))[0]?.status, "active");
  } finally {
    cleanup();
  }
});

test("treats pull request lookup failure as nonfatal", async () => {
  const { repo, store, pointers, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/offline");

    const result = await reconcileMergedWorkspaces({
      store,
      cwd: repo,
      sessionPointers: pointers,
      findMergedPullRequest: async () => {
        throw new Error("offline");
      },
    });

    assert.equal(result.retained[0]?.reason, "pull request status is unavailable");
    assert.equal(result.retained[0]?.actionable, undefined);
    assert.equal(existsSync(workspace.worktree), true);
  } finally {
    cleanup();
  }
});

test("finishes interrupted cleanup for a completed record", async () => {
  const { root, repo, store, pointers, cleanup } = fixture();
  try {
    let workspace = await createWorkspace(store, repo, "feature/retry");
    const missingSession = join(root, "already-missing.jsonl");
    await pointers.write(workspace.worktree, missingSession);
    workspace = await updateWorkspace(store, workspace, {
      status: "completed",
      sessionFile: missingSession,
    });
    git(repo, "worktree", "remove", workspace.worktree);

    const result = await reconcileMergedWorkspaces({ store, cwd: repo, sessionPointers: pointers });

    assert.equal(result.removed[0]?.workspaceId, workspace.id);
    assert.equal(await pointers.read(workspace.worktree), undefined);
    assert.deepEqual(await records(store, repo), []);
  } finally {
    cleanup();
  }
});

test("keeps the completed checkpoint and session state when worktree removal fails", async () => {
  const { root, repo, store, pointers, cleanup } = fixture();
  try {
    const workspace = await attachSession(
      store,
      pointers,
      await createWorkspace(store, repo, "feature/removal-failure"),
      root,
    );
    git(repo, "worktree", "lock", workspace.worktree);

    const result = await reconcileMergedWorkspaces({
      store,
      cwd: repo,
      sessionPointers: pointers,
      findMergedPullRequest: merged(),
    });

    assert.match(result.retained[0]?.reason ?? "", /cleanup failed/);
    const checkpoint = (await records(store, repo))[0];
    assert.equal(checkpoint?.status, "completed");
    assert.equal(checkpoint?.completionHeadSha, git(workspace.worktree, "rev-parse", "HEAD"));
    assert.equal(checkpoint?.completionPrNumber, 17);
    assert.equal(existsSync(workspace.sessionFile!), true);
    assert.equal(await pointers.read(workspace.worktree), workspace.sessionFile);
  } finally {
    cleanup();
  }
});

test("only reconciles records belonging to the primary repository", async () => {
  const { root, repo, store, pointers, cleanup } = fixture();
  try {
    const otherRepo = createRepository(root, "other-repo");
    const current = await createWorkspace(store, repo, "feature/current");
    const other = await createWorkspace(store, otherRepo, "feature/other");

    const result = await reconcileMergedWorkspaces({
      store,
      cwd: repo,
      sessionPointers: pointers,
      findMergedPullRequest: merged(),
    });

    assert.equal(result.removed[0]?.workspaceId, current.id);
    assert.equal(existsSync(other.worktree), true);
    assert.equal((await records(store, otherRepo))[0]?.id, other.id);
  } finally {
    cleanup();
  }
});
