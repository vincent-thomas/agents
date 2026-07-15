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
  gitPush,
  extractRunId,
  trimLog,
  parseReviewComments,
  parseReviews,
  decisiveReview,
  type Review,
} from "./logic.ts";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
// parseReviewComments
// ---------------------------------------------------------------------------

suite("parseReviewComments", () => {
  test("maps a single-line comment (no start_line)", () => {
    const raw = [{ id: 1, path: "a.ts", line: 42, body: "fix this", user: { login: "alice" } }];
    const [comment] = parseReviewComments(raw, 99);
    assert.deepEqual(comment, {
      id: 1,
      pullRequestReviewId: 99,
      path: "a.ts",
      line: 42,
      startLine: null,
      body: "fix this",
      author: "alice",
    });
  });

  test("maps a multi-line comment's start_line to startLine", () => {
    const raw = [
      {
        id: 2,
        path: "b.ts",
        line: 10,
        start_line: 5,
        body: "range comment",
        user: { login: "bob" },
      },
    ];
    const [comment] = parseReviewComments(raw, 100);
    assert.equal(comment.startLine, 5);
    assert.equal(comment.line, 10);
  });

  test("defaults missing fields", () => {
    const [comment] = parseReviewComments([{ id: 3 }], 1);
    assert.equal(comment.path, "");
    assert.equal(comment.line, null);
    assert.equal(comment.startLine, null);
    assert.equal(comment.body, "");
    assert.equal(comment.author, "unknown");
  });

  test("non-array input returns empty list", () => {
    assert.deepEqual(parseReviewComments(null, 1), []);
    assert.deepEqual(parseReviewComments(undefined, 1), []);
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
// decisiveReview
// ---------------------------------------------------------------------------

function review(overrides: Partial<Review> & { state: string; submittedAt: string }): Review {
  return {
    id: 1,
    author: "alice",
    body: "",
    commitId: "head",
    ...overrides,
  };
}

suite("decisiveReview", () => {
  test("no reviews → null", () => {
    assert.equal(decisiveReview([]), null);
  });

  test("only COMMENTED/PENDING → null (no decision yet)", () => {
    const active = [
      review({ state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z" }),
      review({ state: "PENDING", submittedAt: "2026-01-01T01:00:00Z", author: "bob" }),
    ];
    assert.equal(decisiveReview(active), null);
  });

  test("a later COMMENTED review does not mask an approval", () => {
    const active = [
      review({ id: 1, state: "APPROVED", submittedAt: "2026-01-01T00:00:00Z" }),
      review({ id: 2, state: "COMMENTED", submittedAt: "2026-01-01T02:00:00Z" }),
    ];
    const result = decisiveReview(active);
    assert.equal(result?.state, "APPROVED");
    assert.equal(result?.id, 1);
  });

  test("a later COMMENTED review does not mask a changes-requested", () => {
    const active = [
      review({ id: 1, state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T00:00:00Z" }),
      review({ id: 2, state: "COMMENTED", submittedAt: "2026-01-01T02:00:00Z" }),
    ];
    assert.equal(decisiveReview(active)?.state, "CHANGES_REQUESTED");
  });

  test("a reviewer's newer approval supersedes their older changes-requested", () => {
    const active = [
      review({ id: 1, state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T00:00:00Z" }),
      review({ id: 2, state: "APPROVED", submittedAt: "2026-01-01T03:00:00Z" }),
    ];
    const result = decisiveReview(active);
    assert.equal(result?.state, "APPROVED");
    assert.equal(result?.id, 2);
  });

  test("an outstanding changes-requested from one reviewer blocks another's approval", () => {
    const active = [
      review({ author: "alice", state: "APPROVED", submittedAt: "2026-01-01T05:00:00Z" }),
      review({ author: "bob", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T01:00:00Z" }),
    ];
    const result = decisiveReview(active);
    assert.equal(result?.state, "CHANGES_REQUESTED");
    assert.equal(result?.author, "bob");
  });

  test("multiple approvals → most recent one is returned", () => {
    const active = [
      review({ author: "alice", state: "APPROVED", submittedAt: "2026-01-01T01:00:00Z" }),
      review({ author: "bob", state: "APPROVED", submittedAt: "2026-01-01T04:00:00Z" }),
    ];
    assert.equal(decisiveReview(active)?.author, "bob");
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
});
