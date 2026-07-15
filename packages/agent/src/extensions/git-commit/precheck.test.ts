/**
 * precheck.test.ts — tests for the Makefile-driven pre-check runner.
 *
 * Run with:   node --test precheck.test.ts
 */
import assert from "node:assert/strict";
import { test, suite } from "node:test";
import { runPreChecks } from "./precheck.ts";
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

suite("runPreChecks", () => {
  test(
    "no Makefile → passes trivially with no steps",
    withTmpDir(async (dir) => {
      const result = await runPreChecks(dir);
      assert.deepEqual(result, { passed: true, steps: [] });
    }),
  );

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
