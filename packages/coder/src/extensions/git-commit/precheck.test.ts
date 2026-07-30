/**
 * precheck.test.ts — tests for the Makefile-driven pre-check runner.
 *
 * Run with:   node --test precheck.test.ts
 */
import assert from "node:assert/strict";
import { test, suite } from "node:test";
import { formatSuccessfulPreChecks, runGitPreChecks, runPreChecks } from "./precheck.ts";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function withTmpDir(fn: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "precheck-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function git(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["pipe", "pipe", "pipe"] })
    .toString()
    .trim();
}

function withGitRepo(fn: (dir: string) => void | Promise<void>): () => Promise<void> {
  return withTmpDir(async (dir) => {
    git("git init", dir);
    git("git config user.email test@test.com", dir);
    git("git config user.name test", dir);
    writeFileSync(join(dir, "tracked.txt"), "initial\n");
    git("git add tracked.txt", dir);
    git("git commit -m init", dir);
    await fn(dir);
  });
}

suite("runPreChecks", () => {
  test(
    "no Makefile → passes trivially with no steps",
    withTmpDir(async (dir) => {
      const result = await runPreChecks(dir);
      assert.deepEqual(result, { passed: true, steps: [] });
    }),
  );

  test("describes skipped project validation", () => {
    assert.equal(
      formatSuccessfulPreChecks({ passed: true, steps: [] }),
      "Project validation skipped: no Makefile or `make` unavailable.",
    );
  });

  test("describes passed project validation", () => {
    assert.equal(
      formatSuccessfulPreChecks({
        passed: true,
        steps: [{ command: "make", passed: true, output: "" }],
      }),
      "Project validation passed: `make`.",
    );
  });

  test(
    "Makefile whose default target succeeds → passed with captured output",
    withTmpDir(async (dir) => {
      writeFileSync(join(dir, "Makefile"), "all:\n\t@echo build-ok\n");
      const result = await runPreChecks(dir);
      assert.equal(result.passed, true);
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].command, "make");
      assert.ok(result.steps[0].output.includes("build-ok"));
      assert.equal(result.steps[0].passed, true);
    }),
  );

  test(
    "Makefile whose default target fails → not passed with error output",
    withTmpDir(async (dir) => {
      writeFileSync(join(dir, "Makefile"), "all:\n\t@echo failure-output >&2\n\t@exit 1\n");
      const result = await runPreChecks(dir);
      assert.equal(result.passed, false);
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].passed, false);
      assert.ok(result.steps[0].output.includes("failure-output"));
    }),
  );

  test(
    "invokes onStep with the same step reported in the result",
    withTmpDir(async (dir) => {
      writeFileSync(join(dir, "Makefile"), "all:\n\t@echo hi\n");
      const seen: unknown[] = [];
      const result = await runPreChecks(dir, undefined, (step) => seen.push(step));
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], result.steps[0]);
    }),
  );
});

suite("runGitPreChecks", () => {
  test(
    "passes a clean staged change",
    withGitRepo(async (dir) => {
      writeFileSync(join(dir, "tracked.txt"), "changed\n");
      git("git add tracked.txt", dir);

      const result = await runGitPreChecks(dir);

      assert.equal(result.passed, true);
      assert.deepEqual(
        result.steps.map((step) => step.command),
        [
          "git ls-files -u",
          "git diff --check",
          "git diff --cached --check",
          "conflict-marker scan",
        ],
      );
    }),
  );

  test(
    "rejects unmerged index entries",
    withGitRepo(async (dir) => {
      git("git checkout -b conflicting", dir);
      writeFileSync(join(dir, "tracked.txt"), "branch\n");
      git("git commit -am branch", dir);
      git("git checkout -", dir);
      writeFileSync(join(dir, "tracked.txt"), "main\n");
      git("git commit -am main", dir);
      try {
        git("git merge conflicting", dir);
      } catch {
        // The conflict is the state under test.
      }

      const result = await runGitPreChecks(dir);

      assert.equal(result.passed, false);
      assert.equal(result.steps.at(-1)?.command, "git ls-files -u");
      assert.match(result.steps.at(-1)?.output ?? "", /tracked\.txt/);
    }),
  );

  test(
    "rejects whitespace errors",
    withGitRepo(async (dir) => {
      writeFileSync(join(dir, "tracked.txt"), "trailing whitespace \n");

      const result = await runGitPreChecks(dir);

      assert.equal(result.passed, false);
      assert.equal(result.steps.at(-1)?.command, "git diff --check");
      assert.match(result.steps.at(-1)?.output ?? "", /trailing whitespace/);
    }),
  );

  test(
    "rejects conflict markers in changed staged text files",
    withGitRepo(async (dir) => {
      writeFileSync(join(dir, "tracked.txt"), "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> side\n");
      git("git add tracked.txt", dir);
      git("git commit -m fixture", dir);
      writeFileSync(
        join(dir, "tracked.txt"),
        "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> side\nchanged\n",
      );
      git("git add tracked.txt", dir);

      const result = await runGitPreChecks(dir);

      assert.equal(result.passed, false);
      assert.equal(result.steps.at(-1)?.command, "conflict-marker scan");
      assert.match(result.steps.at(-1)?.output ?? "", /<<<<<<< HEAD/);
    }),
  );
});
