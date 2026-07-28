import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertOwnedWorkspace,
  assertWorkspacePath,
  createWorkspace,
  listWorkspaces,
  resolveRepository,
  updateWorkspace,
  type WorkspaceStore,
} from "./logic.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
    assert.equal(workspace.baseSha, git(repo, "rev-parse", "HEAD"));
    await assertOwnedWorkspace(workspace);
  } finally {
    cleanup();
  }
});

test("lists repository workspaces and persists session metadata", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const first = await createWorkspace(store, repo, "feature/one");
    const second = await createWorkspace(store, repo, "feature/two");
    const updated = await updateWorkspace(store, first, {
      sessionFile: "/sessions/one.jsonl",
      sessionName: "Refactor auth",
    });
    const repository = await resolveRepository(repo);

    const records = await listWorkspaces(store, repository.repository);

    assert.equal(records.length, 2);
    const persisted = records.find((record) => record.id === updated.id);
    assert.equal(persisted?.sessionFile, "/sessions/one.jsonl");
    assert.equal(persisted?.sessionName, "Refactor auth");
    assert.ok(records.some((record) => record.id === second.id));
  } finally {
    cleanup();
  }
});

test("rejects an existing branch", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const branch = git(repo, "branch", "--show-current");

    await assert.rejects(createWorkspace(store, repo, branch), /Branch already exists/);
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
