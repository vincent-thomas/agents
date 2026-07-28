import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertOwnedWorkspace,
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

    const workspace = await createWorkspace(store, repo);

    assert.equal(git(repo, "branch", "--show-current"), originalBranch);
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "dirty source checkout\n");
    assert.equal(readFileSync(join(workspace.worktree, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(git(workspace.worktree, "branch", "--show-current"), workspace.branch);
    assert.match(workspace.branch, /^agent\/[0-9a-f-]{36}$/);
    assert.equal(workspace.baseSha, git(repo, "rev-parse", "HEAD"));
    await assertOwnedWorkspace(workspace);
  } finally {
    cleanup();
  }
});

test("lists repository workspaces and persists session metadata", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const first = await createWorkspace(store, repo);
    const second = await createWorkspace(store, repo);
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

test("rejects a workspace checked out on a branch it does not own", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo);
    git(workspace.worktree, "checkout", "--detach");

    await assert.rejects(assertOwnedWorkspace(workspace), /branch mismatch|symbolic-ref/);
  } finally {
    cleanup();
  }
});
