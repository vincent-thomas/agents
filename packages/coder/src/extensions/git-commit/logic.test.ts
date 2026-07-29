/**
 * logic.test.ts — tests for git-commit helpers.
 *
 * Run with:   node --test logic.test.ts
 */
import assert from "node:assert/strict";
import { test, suite } from "node:test";
import { branchExistsOnRemote, formatCommitMessage, gitCommit, isDefaultBranch } from "./logic.ts";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Git repo helpers
// ---------------------------------------------------------------------------

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] })
    .toString()
    .trim();
}

function withGitRepo(fn: (repoPath: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "commit-test-"));
    try {
      git("git init", dir);
      git("git config user.email test@test.com", dir);
      git("git config user.name test", dir);
      // Initial commit so HEAD exists.
      writeFileSync(join(dir, "init.txt"), "init");
      git("git add .", dir);
      git("git commit -m init", dir);
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function withGitRepos(
  fn: (local: string, remote: string) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), "commit-remote-test-"));
    const remotePath = join(base, "remote.git");
    const localPath = join(base, "local");
    try {
      execSync(`git init --bare ${remotePath}`, { stdio: "pipe" });
      execSync(`git clone ${remotePath} ${localPath}`, { stdio: "pipe" });
      git("git config user.email test@test.com", localPath);
      git("git config user.name test", localPath);
      writeFileSync(join(localPath, "init.txt"), "init");
      git("git add .", localPath);
      git("git commit -m init", localPath);
      git("git push", localPath);
      await fn(localPath, remotePath);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// isDefaultBranch
// ---------------------------------------------------------------------------

suite("isDefaultBranch", () => {
  test(
    "main branch is default",
    withGitRepo(async (dir) => {
      // Most git repos default to "main" branch
      assert.equal(await isDefaultBranch(dir, "main"), true);
    }),
  );

  test(
    "feature branch is not default",
    withGitRepo(async (dir) => {
      assert.equal(await isDefaultBranch(dir, "feature/foo"), false);
    }),
  );

  test(
    "develop branch is not default",
    withGitRepo(async (dir) => {
      assert.equal(await isDefaultBranch(dir, "develop"), false);
    }),
  );
});

// ---------------------------------------------------------------------------
// branchExistsOnRemote
// ---------------------------------------------------------------------------

suite("branchExistsOnRemote", () => {
  test(
    "current branch already on remote → true",
    withGitRepos(async (local) => {
      const branch = git("git branch --show-current", local);
      assert.equal(await branchExistsOnRemote(local, branch), true);
    }),
  );

  test(
    "local-only branch not yet pushed → false",
    withGitRepos(async (local) => {
      git("git checkout -b feature/unpushed", local);
      assert.equal(await branchExistsOnRemote(local, "feature/unpushed"), false);
    }),
  );

  test(
    "branch name that doesn't exist anywhere → false",
    withGitRepos(async (local) => {
      assert.equal(await branchExistsOnRemote(local, "no-such-branch"), false);
    }),
  );

  test("git failure (no remote configured) → false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "commit-norepo-"));
    try {
      assert.equal(await branchExistsOnRemote(dir, "main"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// formatCommitMessage
// ---------------------------------------------------------------------------

suite("formatCommitMessage", () => {
  test("creates a subject with labeled what and why sections", () => {
    assert.equal(
      formatCommitMessage(
        "Require structured commit messages",
        "Split the commit message into explicit fields.",
        "Agents otherwise tend to provide only a subject.",
      ),
      "Require structured commit messages\n\n" +
        "What: Split the commit message into explicit fields.\n" +
        "Why: Agents otherwise tend to provide only a subject.",
    );
  });
});

// ---------------------------------------------------------------------------
// gitCommit
// ---------------------------------------------------------------------------

suite("gitCommit", () => {
  test(
    "commits staged changes",
    withGitRepo(async (dir) => {
      writeFileSync(join(dir, "file.txt"), "hello");
      git("git add file.txt", dir);
      const result = await gitCommit(dir, "add file");
      assert.equal(result.success, true);
      const log = git("git log --oneline -1", dir);
      assert.ok(log.includes("add file"));
    }),
  );

  test(
    "uses Git's prepared message for a merge commit",
    withGitRepo(async (dir) => {
      const currentBranch = git("git branch --show-current", dir);
      git("git checkout -b target", dir);
      writeFileSync(join(dir, "init.txt"), "target");
      git("git add init.txt", dir);
      git("git commit -m target", dir);
      git(`git checkout ${currentBranch}`, dir);
      writeFileSync(join(dir, "init.txt"), "current");
      git("git add init.txt", dir);
      git("git commit -m current", dir);
      assert.throws(() => git("git merge --no-commit --no-ff target", dir));
      git("git checkout --ours init.txt", dir);
      git("git add init.txt", dir);
      assert.equal(git("git diff --cached --name-only", dir), "");

      const result = await gitCommit(dir);

      assert.equal(result.success, true);
      assert.equal(git("git show --format=%P --no-patch HEAD", dir).split(" ").length, 2);
      assert.match(git("git log --format=%s -1", dir), /^Merge branch 'target'/);
    }),
  );

  test(
    "fails when nothing is staged",
    withGitRepo(async (dir) => {
      const result = await gitCommit(dir, "empty commit");
      assert.equal(result.success, false);
      assert.ok(result.output.includes("Nothing to commit"));
    }),
  );

  test(
    "does NOT stage unstaged changes (leaves them in the working tree)",
    withGitRepo(async (dir) => {
      writeFileSync(join(dir, "staged.txt"), "staged");
      writeFileSync(join(dir, "unstaged.txt"), "unstaged");
      git("git add staged.txt", dir);
      const result = await gitCommit(dir, "only staged");
      assert.equal(result.success, true);
      // unstaged.txt must remain untracked, not swept into the commit.
      const status = git("git status --porcelain", dir);
      assert.ok(status.includes("?? unstaged.txt"));
      const files = git("git show --name-only --oneline HEAD", dir);
      assert.ok(files.includes("staged.txt"));
      assert.ok(!files.includes("unstaged.txt"));
    }),
  );

  test(
    "handles message with single quotes",
    withGitRepo(async (dir) => {
      writeFileSync(join(dir, "file.txt"), "content");
      git("git add file.txt", dir);
      const result = await gitCommit(dir, "it's a test");
      assert.equal(result.success, true);
      const log = git("git log --oneline -1", dir);
      assert.ok(log.includes("it's a test"));
    }),
  );

  test(
    "commits staged modifications",
    withGitRepo(async (dir) => {
      // init.txt already exists from withGitRepo
      writeFileSync(join(dir, "init.txt"), "modified");
      git("git add init.txt", dir);
      const result = await gitCommit(dir, "modify init");
      assert.equal(result.success, true);
      const log = git("git log --oneline -1", dir);
      assert.ok(log.includes("modify init"));
    }),
  );

  test(
    "commits staged deletions",
    withGitRepo(async (dir) => {
      rmSync(join(dir, "init.txt"));
      git("git add -A", dir);
      const result = await gitCommit(dir, "delete init");
      assert.equal(result.success, true);
      const log = git("git log --oneline -1", dir);
      assert.ok(log.includes("delete init"));
    }),
  );
});
