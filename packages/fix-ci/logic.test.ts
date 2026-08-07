/**
 * logic.test.ts — tests for fix-ci helpers.
 *
 * Run with:   node --test logic.test.ts
 */
import assert from "node:assert/strict";
import { test, suite } from "node:test";
import {
  isFailure,
  mapCheckRun,
  mapStatusState,
  allSuitesComplete,
  needsPush,
  branchExistsOnOrigin,
  findClosestBaseBranch,
  getPrBaseBranch,
  rebaseCurrentBranchOntoBase,
  createDraftPr,
  gitPush,
  prReadyCommand,
  prViewForBranchCommand,
  extractRunId,
  trimLog,
  parseReviews,
} from "./logic.ts";
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Explicit PR command targets
// ---------------------------------------------------------------------------

suite("PR command targets", () => {
  test("terminates options before explicit stack branch targets", () => {
    assert.equal(
      prViewForBranchCommand("--repo=other/project"),
      "gh pr view --json number,state,isDraft,headRefOid -- '--repo=other/project'",
    );
    assert.equal(prReadyCommand("feature/part-one"), "gh pr ready -- 'feature/part-one'");
  });

  test("preserves ordinary current-branch readiness", () => {
    assert.equal(prReadyCommand(), "gh pr ready");
  });
});

// ---------------------------------------------------------------------------
// isFailure (bucket-based)
// ---------------------------------------------------------------------------

suite("isFailure", () => {
  test("fail bucket", () => assert.ok(isFailure("fail")));
  test("cancel bucket", () => assert.ok(isFailure("cancel")));
  test("pass bucket", () => assert.ok(!isFailure("pass")));
  test("pending bucket", () => assert.ok(!isFailure("pending")));
  test("skipping bucket", () => assert.ok(!isFailure("skipping")));
});

// ---------------------------------------------------------------------------
// mapCheckRun (SHA-pinned check-run mapping)
// ---------------------------------------------------------------------------

suite("mapCheckRun", () => {
  test("completed/success → pass", () =>
    assert.deepEqual(mapCheckRun("completed", "success"), {
      state: "SUCCESS",
      bucket: "pass",
    }));
  test("completed/failure → fail", () =>
    assert.equal(mapCheckRun("completed", "failure").bucket, "fail"));
  test("completed/timed_out → fail", () =>
    assert.equal(mapCheckRun("completed", "timed_out").bucket, "fail"));
  test("completed/null → fail", () => assert.equal(mapCheckRun("completed", null).bucket, "fail"));
  test("completed/skipped → skipping", () =>
    assert.equal(mapCheckRun("completed", "skipped").bucket, "skipping"));
  test("completed/neutral → skipping", () =>
    assert.equal(mapCheckRun("completed", "neutral").bucket, "skipping"));
  test("completed/cancelled → cancel", () =>
    assert.equal(mapCheckRun("completed", "cancelled").bucket, "cancel"));
  test("queued → pending", () =>
    assert.deepEqual(mapCheckRun("queued", null), {
      state: "PENDING",
      bucket: "pending",
    }));
  test("in_progress → pending", () =>
    assert.deepEqual(mapCheckRun("in_progress", null), {
      state: "IN_PROGRESS",
      bucket: "pending",
    }));
});

// ---------------------------------------------------------------------------
// mapStatusState (commit-status mapping)
// ---------------------------------------------------------------------------

suite("mapStatusState", () => {
  test("success → pass", () => assert.equal(mapStatusState("success").bucket, "pass"));
  test("pending → pending", () =>
    assert.deepEqual(mapStatusState("pending"), {
      state: "PENDING",
      bucket: "pending",
    }));
  test("failure → fail", () => assert.equal(mapStatusState("failure").bucket, "fail"));
  test("error → fail", () => assert.equal(mapStatusState("error").bucket, "fail"));
});

// ---------------------------------------------------------------------------
// allSuitesComplete (registration-window guard)
// ---------------------------------------------------------------------------

suite("allSuitesComplete", () => {
  test("empty list → complete", () => assert.ok(allSuitesComplete([])));
  test("all completed → complete", () => assert.ok(allSuitesComplete(["completed", "completed"])));
  test("any queued → not complete", () => assert.ok(!allSuitesComplete(["completed", "queued"])));
  test("any in_progress → not complete", () => assert.ok(!allSuitesComplete(["in_progress"])));
});

suite("extractRunId", () => {
  test("standard GitHub Actions URL", () => {
    assert.equal(
      extractRunId("https://github.com/owner/repo/actions/runs/12345678/job/9999"),
      "12345678",
    );
  });

  test("URL without job suffix", () => {
    assert.equal(extractRunId("https://github.com/owner/repo/actions/runs/12345678"), "12345678");
  });

  test("null URL", () => assert.equal(extractRunId(null), null));
  test("unrelated URL", () =>
    assert.equal(extractRunId("https://github.com/owner/repo/pull/42"), null));
  test("empty string", () => assert.equal(extractRunId(""), null));
});

suite("trimLog", () => {
  test("short log returned as-is", () => {
    const log = "line1\nline2\nline3";
    assert.equal(trimLog(log, 10), log);
  });

  test("long log is trimmed to last N lines", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    const log = lines.join("\n");
    const result = trimLog(log, 200);
    assert.ok(result.startsWith("… (100 lines trimmed) …\n"));
    assert.ok(result.endsWith("line 300"));
    assert.equal(result.split("\n").length, 201);
  });

  test("exact boundary — no trimming", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const log = lines.join("\n");
    assert.equal(trimLog(log, 200), log);
  });
});

// ---------------------------------------------------------------------------
// parseReviews
// ---------------------------------------------------------------------------

suite("parseReviews", () => {
  test("maps a REST-shaped review (reviewer under .user)", () => {
    const raw = [
      {
        id: 7,
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
        body: "needs work",
        submitted_at: "2026-01-02T03:04:05Z",
        commit_id: "abc123",
      },
    ];
    const [review] = parseReviews(raw);
    assert.deepEqual(review, {
      id: 7,
      author: "alice",
      state: "CHANGES_REQUESTED",
      body: "needs work",
      submittedAt: "2026-01-02T03:04:05Z",
      commitId: "abc123",
    });
  });

  test("falls back to .author.login when .user is absent (GraphQL shape)", () => {
    const [review] = parseReviews([{ id: 8, author: { login: "bob" }, state: "APPROVED" }]);
    assert.equal(review.author, "bob");
  });

  test("defaults missing fields", () => {
    const [review] = parseReviews([{ id: 9 }]);
    assert.equal(review.author, "unknown");
    assert.equal(review.state, "UNKNOWN");
    assert.equal(review.body, "");
    assert.equal(review.submittedAt, "");
    assert.equal(review.commitId, null);
  });

  test("non-array input returns empty list", () => {
    assert.deepEqual(parseReviews(null), []);
    assert.deepEqual(parseReviews(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// Test helpers — shared by the needsPush and gitPush suites below
// ---------------------------------------------------------------------------

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] })
    .toString()
    .trim();
}

async function withFakeGh<T>(cwd: string, script: string, fn: () => Promise<T>): Promise<T> {
  const bin = join(cwd, "fake-bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/bin/sh\n${script}\n`);
  chmodSync(gh, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  try {
    return await fn();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

function withGitRepos(
  fn: (local: string, remote: string) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), "push-test-"));
    const remotePath = join(base, "remote.git");
    const localPath = join(base, "local");
    try {
      // Create a bare "remote" and clone it.
      execSync(`git init --bare ${remotePath}`, { stdio: "pipe" });
      execSync(`git clone ${remotePath} ${localPath}`, { stdio: "pipe" });
      git("git config user.email test@test.com", localPath);
      git("git config user.name test", localPath);
      // Initial commit so main exists.
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
// Rebase current branch onto the fetched PR base
// ---------------------------------------------------------------------------

suite("rebaseCurrentBranchOntoBase", () => {
  test(
    "rebases onto the verified current base SHA",
    withGitRepos(async (local) => {
      const baseBranch = git("git branch --show-current", local);
      git("git checkout -b feature", local);
      writeFileSync(join(local, "feature.txt"), "feature");
      git("git add . && git commit -m feature", local);
      git(`git checkout ${baseBranch}`, local);
      writeFileSync(join(local, "base.txt"), "base");
      git("git add . && git commit -m base-update", local);
      git("git push origin HEAD", local);
      const baseSha = git("git rev-parse HEAD", local);
      git("git checkout feature", local);

      const result = await withFakeGh(local, `printf '%s\\n' ${baseSha}`, () =>
        rebaseCurrentBranchOntoBase(local, baseBranch, "feature"),
      );

      assert.equal(result.success, true, result.output);
      assert.equal(git(`git merge-base --is-ancestor ${baseBranch} HEAD; printf $?`, local), "0");
      assert.equal(git(`git rev-list --count ${baseBranch}..HEAD`, local), "1");
      assert.equal(git("git show -s --format=%s HEAD", local), "feature");
    }),
  );

  test(
    "leaves rebase conflicts in place for resolution",
    withGitRepos(async (local) => {
      const baseBranch = git("git branch --show-current", local);
      git("git checkout -b feature", local);
      writeFileSync(join(local, "conflict.txt"), "feature");
      git("git add . && git commit -m feature", local);
      git("git checkout " + baseBranch, local);
      writeFileSync(join(local, "conflict.txt"), "base");
      git("git add . && git commit -m base-update", local);
      git("git push origin HEAD", local);
      const baseSha = git("git rev-parse HEAD", local);
      git("git checkout feature", local);

      const result = await withFakeGh(local, `printf '%s\\n' ${baseSha}`, () =>
        rebaseCurrentBranchOntoBase(local, baseBranch, "feature"),
      );

      assert.equal(result.success, false);
      assert.deepEqual(result.conflictPaths, ["conflict.txt"]);
      assert.notEqual(git("git ls-files -u", local), "");
      assert.equal(git("git rev-parse --verify -q REBASE_HEAD", local).length, 40);
      git("git rebase --abort", local);
    }),
  );
});

// ---------------------------------------------------------------------------
// needsPush
// ---------------------------------------------------------------------------

suite("needsPush", () => {
  test(
    "returns false when branch is up to date",
    withGitRepos(async (local) => {
      const result = await needsPush(local);
      assert.equal(result, false);
    }),
  );

  test(
    "returns true when there are unpushed commits",
    withGitRepos(async (local) => {
      writeFileSync(join(local, "new.txt"), "new");
      git("git add .", local);
      git("git commit -m 'new file'", local);
      const result = await needsPush(local);
      assert.equal(result, true);
    }),
  );

  test(
    "returns true when branch doesn't exist on remote",
    withGitRepos(async (local) => {
      git("git checkout -b new-branch", local);
      writeFileSync(join(local, "branch.txt"), "branch");
      git("git add .", local);
      git("git commit -m 'branch commit'", local);
      const result = await needsPush(local);
      assert.equal(result, true);
    }),
  );

  test(
    "returns false after pushing new commits",
    withGitRepos(async (local) => {
      writeFileSync(join(local, "new.txt"), "new");
      git("git add .", local);
      git("git commit -m 'new file'", local);
      git("git push", local);
      const result = await needsPush(local);
      assert.equal(result, false);
    }),
  );
});

// ---------------------------------------------------------------------------
// branchExistsOnOrigin
// ---------------------------------------------------------------------------

suite("branchExistsOnOrigin", () => {
  test(
    "returns true for a branch present on origin",
    withGitRepos(async (local) => {
      const branch = git("git branch --show-current", local);
      assert.equal(await branchExistsOnOrigin(local, branch), true);
    }),
  );

  test(
    "returns false for a confidently absent branch",
    withGitRepos(async (local) => {
      assert.equal(await branchExistsOnOrigin(local, "feature/missing"), false);
    }),
  );

  test("returns null when the remote lookup fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "branch-lookup-failure-"));
    try {
      assert.equal(await branchExistsOnOrigin(cwd, "main"), null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// findClosestBaseBranch
// ---------------------------------------------------------------------------

suite("findClosestBaseBranch", () => {
  test(
    "selects the remote branch from which the current branch diverged",
    withGitRepos(async (local) => {
      git("git checkout -b feature/parent", local);
      writeFileSync(join(local, "parent.txt"), "parent");
      git("git add .", local);
      git("git commit -m 'parent commit'", local);
      git("git push -u origin feature/parent", local);

      git("git checkout -b feature/child", local);
      writeFileSync(join(local, "child.txt"), "child");
      git("git add .", local);
      git("git commit -m 'child commit'", local);

      assert.equal(await findClosestBaseBranch(local), "feature/parent");
    }),
  );

  test(
    "uses branch-creation history when siblings share the nearest divergence",
    withGitRepos(async (local) => {
      git("git checkout -b feature/parent", local);
      writeFileSync(join(local, "parent.txt"), "parent");
      git("git add .", local);
      git("git commit -m 'parent commit'", local);
      git("git push -u origin feature/parent", local);
      git("git branch feature/sibling", local);
      git("git push origin feature/sibling", local);

      git("git checkout -b feature/child", local);
      writeFileSync(join(local, "child.txt"), "child");
      git("git add .", local);
      git("git commit -m 'child commit'", local);
      git("git push -u origin feature/child", local);

      git("git checkout -b feature/descendant", local);
      writeFileSync(join(local, "descendant.txt"), "descendant");
      git("git add .", local);
      git("git commit -m 'descendant commit'", local);
      git("git push -u origin feature/descendant", local);

      git("git checkout feature/parent", local);
      writeFileSync(join(local, "parent-later.txt"), "parent later");
      git("git add .", local);
      git("git commit -m 'later parent commit'", local);
      git("git push", local);
      git("git checkout feature/child", local);

      assert.equal(await findClosestBaseBranch(local), "feature/parent");
    }),
  );

  test(
    "ignores remote branches with unrelated histories",
    withGitRepos(async (local) => {
      git("git checkout --orphan feature/orphan", local);
      git("git rm -rf .", local);
      writeFileSync(join(local, "orphan.txt"), "orphan");
      git("git add .", local);
      git("git commit -m 'orphan commit'", local);

      assert.equal(await findClosestBaseBranch(local), null);
    }),
  );
});

suite("getPrBaseBranch", () => {
  test(
    "preserves the base reported for an existing PR",
    withGitRepos(async (local) => {
      const fakeGh =
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then\n' +
        '  printf "%s\\n" "feature/recorded-base"\n' +
        "  exit 0\n" +
        "fi\n" +
        "exit 1";
      await withFakeGh(local, fakeGh, async () => {
        assert.equal(await getPrBaseBranch(local), "feature/recorded-base");
      });
    }),
  );

  test(
    "fails safely when GitHub cannot determine whether a PR exists",
    withGitRepos(async (local) => {
      git("git checkout -b feature/current", local);
      writeFileSync(join(local, "feature.txt"), "feature");
      git("git add .", local);
      git("git commit -m 'feature commit'", local);

      await withFakeGh(local, "exit 1", async () => {
        assert.equal(await getPrBaseBranch(local), null);
      });
    }),
  );

  test(
    "does not fall back to an unrelated default branch",
    withGitRepos(async (local) => {
      git("git checkout --orphan feature/orphan", local);
      git("git rm -rf .", local);
      writeFileSync(join(local, "orphan.txt"), "orphan");
      git("git add .", local);
      git("git commit -m 'orphan commit'", local);

      const fakeGh =
        'if [ "$2" = "list" ]; then exit 0; fi\n' +
        'if [ "$2" = "view" ]; then printf "%s\\n" "main"; exit 0; fi\n' +
        "exit 1";
      await withFakeGh(local, fakeGh, async () => {
        assert.equal(await getPrBaseBranch(local), null);
      });
    }),
  );

  test(
    "passes the selected base explicitly to PR creation",
    withGitRepos(async (local) => {
      git("git checkout -b feature/current", local);
      const capturedBase = join(local, "captured-base");
      const fakeGh =
        'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then\n' +
        "  while [ $# -gt 0 ]; do\n" +
        `    if [ "$1" = "--base" ]; then printf "%s\\n" "$2" > ${JSON.stringify(capturedBase)}; fi\n` +
        "    shift\n" +
        "  done\n" +
        '  printf "%s\\n" "https://example.test/pull/1"\n' +
        "  exit 0\n" +
        "fi\n" +
        "exit 1";

      await withFakeGh(local, fakeGh, async () => {
        const result = await createDraftPr(
          local,
          "Feature title",
          "Feature body",
          "feature/parent",
        );
        assert.equal(result.success, true);
        assert.equal(readFileSync(capturedBase, "utf8").trim(), "feature/parent");
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// gitPush
// ---------------------------------------------------------------------------

suite("gitPush", () => {
  test(
    "pushes commits on an already-tracked branch",
    withGitRepos(async (local) => {
      writeFileSync(join(local, "new.txt"), "new");
      git("git add .", local);
      git("git commit -m 'new file'", local);

      const result = await gitPush(local);
      assert.equal(result.success, true);
      assert.equal(await needsPush(local), false);
    }),
  );

  test(
    "pushes a brand-new branch with no upstream (sets upstream)",
    withGitRepos(async (local) => {
      git("git checkout -b feature/new", local);
      writeFileSync(join(local, "branch.txt"), "branch");
      git("git add .", local);
      git("git commit -m 'branch commit'", local);

      // No upstream is configured for this branch yet.
      const result = await gitPush(local);
      assert.equal(result.success, true, result.output);

      // Upstream is now set and there's nothing left to push.
      const upstream = git("git rev-parse --abbrev-ref --symbolic-full-name @{u}", local);
      assert.equal(upstream, "origin/feature/new");
      assert.equal(await needsPush(local), false);
    }),
  );

  test(
    "updates a rebased branch with force-with-lease without creating a merge commit",
    withGitRepos(async (local, remote) => {
      const baseBranch = git("git branch --show-current", local);
      git("git checkout -b feature", local);
      writeFileSync(join(local, "feature.txt"), "feature");
      git("git add . && git commit -m feature", local);
      git("git push -u origin feature", local);

      git(`git checkout ${baseBranch}`, local);
      writeFileSync(join(local, "base.txt"), "base update");
      git("git add . && git commit -m base-update", local);
      git("git push origin HEAD", local);
      git("git checkout feature", local);
      const oldRemoteHead = git("git rev-parse origin/feature", local);
      git(`git rebase ${baseBranch}`, local);
      assert.notEqual(git("git rev-parse HEAD", local), oldRemoteHead);

      const result = await gitPush(local, undefined, { forceWithLease: true });
      assert.equal(result.success, true, result.output);
      const remoteHead = git("git --git-dir " + remote + " rev-parse refs/heads/feature", local);
      assert.equal(remoteHead, git("git rev-parse HEAD", local));
      assert.equal(
        git("git --git-dir " + remote + " rev-list --merges --count refs/heads/feature", local),
        "0",
      );
    }),
  );
});
