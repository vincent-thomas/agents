import assert from "node:assert/strict";
import { suite, test } from "node:test";
import { checkAndReadyStack, type StackReadinessDependencies } from "./stack-readiness.ts";
import type { CheckResult } from "./logic.ts";

const passingCheck: CheckResult = {
  name: "test",
  state: "SUCCESS",
  bucket: "pass",
  link: null,
};

function run(
  branches: string[],
  options: {
    checks?: Record<string, CheckResult[]>;
    timedOut?: Set<string>;
    resolutions?: Record<
      string,
      {
        sha: string | null;
        pr: { number: number; state: string; isDraft: boolean; headRefOid: string } | null;
      }
    >;
    readyFailures?: Set<string>;
  } = {},
) {
  const readyCalls: string[] = [];
  const readyBranches = new Set<string>();
  const pollCalls: string[] = [];
  const dependencies: StackReadinessDependencies = {
    resolveBranch: async (_cwd, branch) => {
      const configured = options.resolutions?.[branch];
      if (configured) return configured;
      return {
        sha: `sha-${branch}`,
        pr: {
          number: branches.indexOf(branch) + 1,
          state: "OPEN",
          isDraft: !readyBranches.has(branch),
          headRefOid: `sha-${branch}`,
        },
      };
    },
    pollChecks: async (_cwd, _signal, _onStatus, sha) => {
      pollCalls.push(sha);
      const branch = sha.slice(4);
      return {
        checks: options.checks?.[branch] ?? [passingCheck],
        timedOut: options.timedOut?.has(branch) ?? false,
        polls: options.timedOut?.has(branch) ? 3 : 1,
        mode: `commit ${sha}`,
      };
    },
    fetchFailureLogs: async (failures) =>
      failures.map((check) => ({ name: check.name, link: check.link, runId: "1", log: "failed" })),
    markPrReady: async (_cwd, _signal, branch) => {
      readyCalls.push(branch);
      const success = !options.readyFailures?.has(branch);
      if (success) readyBranches.add(branch);
      return success;
    },
  };
  return checkAndReadyStack("/workspace", branches, undefined, () => {}, dependencies).then(
    (result) => ({
      result,
      readyCalls,
      pollCalls,
    }),
  );
}

suite("stack readiness orchestration", () => {
  test("checks every branch and marks every draft ready after all pass", async () => {
    const { result, readyCalls, pollCalls } = await run(["base", "tip"]);
    assert.equal(result.allChecksPassed, true);
    assert.equal(result.allReady, true);
    assert.deepEqual(pollCalls, ["sha-base", "sha-tip"]);
    assert.deepEqual(readyCalls, ["base", "tip"]);
    assert.deepEqual(
      result.branches.map((branch) => branch.ready),
      [true, true],
    );
    assert.deepEqual(
      result.branches.map((branch) => branch.isDraft),
      [false, false],
    );
  });

  test("one failed branch means none are marked ready and includes logs", async () => {
    const { result, readyCalls } = await run(["base", "tip"], {
      checks: {
        tip: [{ name: "test", state: "FAILURE", bucket: "fail", link: "https://run" }],
      },
    });
    assert.equal(result.allChecksPassed, false);
    assert.deepEqual(readyCalls, []);
    assert.equal(result.branches[1]?.failureLogs[0]?.log, "failed");
  });

  test("zero checks blocks readiness", async () => {
    const { result, readyCalls } = await run(["tip"], { checks: { tip: [] } });
    assert.equal(result.allChecksPassed, false);
    assert.deepEqual(readyCalls, []);
    assert.match(result.branches[0]?.reason ?? "", /no checks ran/);
  });

  test("timeout blocks readiness", async () => {
    const { result, readyCalls } = await run(["tip"], { timedOut: new Set(["tip"]) });
    assert.equal(result.allChecksPassed, false);
    assert.deepEqual(readyCalls, []);
    assert.match(result.branches[0]?.reason ?? "", /timed out/);
  });

  test("missing PR or SHA blocks readiness", async () => {
    const { result, readyCalls } = await run(["missing-pr", "missing-sha"], {
      resolutions: {
        "missing-pr": { sha: "sha-missing-pr", pr: null },
        "missing-sha": {
          sha: null,
          pr: { number: 2, state: "OPEN", isDraft: true, headRefOid: "sha-missing" },
        },
      },
    });
    assert.equal(result.allChecksPassed, false);
    assert.deepEqual(readyCalls, []);
    assert.match(result.branches[0]?.reason ?? "", /missing open PR/);
    assert.match(result.branches[1]?.reason ?? "", /missing local SHA/);
  });

  test("reports partial ready-command failure after all checks pass", async () => {
    const { result, readyCalls } = await run(["base", "tip"], {
      readyFailures: new Set(["tip"]),
    });
    assert.equal(result.allChecksPassed, true);
    assert.equal(result.allReady, false);
    assert.deepEqual(readyCalls, ["base", "tip"]);
    assert.deepEqual(
      result.branches.map((branch) => branch.ready),
      [true, false],
    );
  });

  test("does not poll when the PR head SHA differs from local", async () => {
    const { result, readyCalls, pollCalls } = await run(["tip"], {
      resolutions: {
        tip: {
          sha: "local-sha",
          pr: { number: 1, state: "OPEN", isDraft: true, headRefOid: "remote-sha" },
        },
      },
    });
    assert.equal(result.allChecksPassed, false);
    assert.deepEqual(pollCalls, []);
    assert.deepEqual(readyCalls, []);
    assert.match(result.branches[0]?.reason ?? "", /not local SHA/);
  });

  test("re-resolves every branch and marks none ready after a post-poll race", async () => {
    let resolveCount = 0;
    const readyCalls: string[] = [];
    const dependencies: StackReadinessDependencies = {
      resolveBranch: async (_cwd, branch) => {
        resolveCount++;
        const changed = branch === "tip" && resolveCount > 2;
        const sha = changed ? "sha-tip-new" : `sha-${branch}`;
        return {
          sha,
          pr: { number: branch === "base" ? 1 : 2, state: "OPEN", isDraft: true, headRefOid: sha },
        };
      },
      pollChecks: async (_cwd, _signal, _onStatus, sha) => ({
        checks: [passingCheck],
        timedOut: false,
        polls: 1,
        mode: `commit ${sha}`,
      }),
      fetchFailureLogs: async () => [],
      markPrReady: async (_cwd, _signal, branch) => {
        readyCalls.push(branch);
        return true;
      },
    };
    const result = await checkAndReadyStack(
      "/workspace",
      ["base", "tip"],
      undefined,
      () => {},
      dependencies,
    );
    assert.equal(result.allChecksPassed, false);
    assert.equal(result.allReady, false);
    assert.deepEqual(readyCalls, []);
    assert.match(result.branches[1]?.reason ?? "", /changed before ready/);
  });

  test("revalidates a PR immediately before marking it ready", async () => {
    let resolveCount = 0;
    const readyCalls: string[] = [];
    const dependencies: StackReadinessDependencies = {
      resolveBranch: async () => {
        resolveCount++;
        const sha = resolveCount === 3 ? "sha-tip-new" : "sha-tip";
        return {
          sha,
          pr: { number: 1, state: "OPEN", isDraft: true, headRefOid: sha },
        };
      },
      pollChecks: async () => ({
        checks: [passingCheck],
        timedOut: false,
        polls: 1,
        mode: "commit sha-tip",
      }),
      fetchFailureLogs: async () => [],
      markPrReady: async (_cwd, _signal, branch) => {
        readyCalls.push(branch);
        return true;
      },
    };

    const result = await checkAndReadyStack(
      "/workspace",
      ["tip"],
      undefined,
      () => {},
      dependencies,
    );

    assert.equal(result.allChecksPassed, false);
    assert.equal(result.allReady, false);
    assert.deepEqual(readyCalls, []);
    assert.match(result.branches[0]?.reason ?? "", /immediately before ready/);
  });

  test("revalidates already-ready branches before mutating a draft", async () => {
    const resolveCounts = new Map<string, number>();
    const readyCalls: string[] = [];
    const dependencies: StackReadinessDependencies = {
      resolveBranch: async (_cwd, branch) => {
        const count = (resolveCounts.get(branch) ?? 0) + 1;
        resolveCounts.set(branch, count);
        const changed = branch === "ready" && count === 3;
        const sha = changed ? "sha-ready-new" : `sha-${branch}`;
        return {
          sha,
          pr: {
            number: branch === "ready" ? 1 : 2,
            state: "OPEN",
            isDraft: branch !== "ready",
            headRefOid: sha,
          },
        };
      },
      pollChecks: async (_cwd, _signal, _onStatus, sha) => ({
        checks: [passingCheck],
        timedOut: false,
        polls: 1,
        mode: `commit ${sha}`,
      }),
      fetchFailureLogs: async () => [],
      markPrReady: async (_cwd, _signal, branch) => {
        readyCalls.push(branch);
        return true;
      },
    };

    const result = await checkAndReadyStack(
      "/workspace",
      ["ready", "draft"],
      undefined,
      () => {},
      dependencies,
    );

    assert.equal(result.allChecksPassed, false);
    assert.equal(result.allReady, false);
    assert.deepEqual(readyCalls, []);
    assert.match(result.branches[0]?.reason ?? "", /immediately before ready/);
  });

  test("skipped checks do not count as passing", async () => {
    const { result, readyCalls } = await run(["tip"], {
      checks: { tip: [{ name: "optional", state: "SKIPPED", bucket: "skipping", link: null }] },
    });
    assert.equal(result.allChecksPassed, false);
    assert.equal(result.allReady, false);
    assert.deepEqual(readyCalls, []);
  });
});
