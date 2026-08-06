import assert from "node:assert/strict";
import { suite, test } from "node:test";
import {
  isMiddleInsertionRejectionOutput,
  isNotStackOutput,
  isStackViewStacked,
  parseGhStackView,
  parseGhStackRemoteStacks,
  probeGhStack,
  probeGhStackRemote,
  resolveGhStackTarget,
  runGhStackCheckout,
  runGhStackInit,
  runGhStackUnstack,
  runGhStackUnstackLocal,
  runGhStackSubmit,
  runGhStackLink,
  runGhStackSync,
  stackBaseBranch,
  stackBranchNames,
  stackCheckoutArgs,
  stackRemoteMembershipArgs,
  stackInitArgs,
  stackLinkArgs,
  stackSubmitArgs,
  stackUnstackArgs,
  stackUnstackLocalArgs,
  stackSyncArgs,
  stackViewArgs,
  withRerereGitConfig,
  type GhStackCommandRunner,
} from "./github-stack.ts";
import { parseUnmergedPaths } from "./logic.ts";

suite("GitHub stack command builders", () => {
  test("builds safe init arguments with an optional base", () => {
    assert.deepEqual(stackInitArgs(["first", "second"], "main"), [
      "stack",
      "init",
      "--base",
      "main",
      "--",
      "first",
      "second",
    ]);
    assert.deepEqual(stackInitArgs(["feature/a"]), ["stack", "init", "--", "feature/a"]);
  });

  test("builds an explicitly terminated checkout command", () => {
    assert.deepEqual(stackCheckoutArgs("feature/one"), ["stack", "checkout", "--", "feature/one"]);
  });

  test("builds official view, sync, submit, and link commands", () => {
    assert.deepEqual(stackViewArgs(), ["stack", "view", "--json"]);
    assert.deepEqual(stackUnstackArgs(), ["stack", "unstack"]);
    assert.deepEqual(stackUnstackLocalArgs(), ["stack", "unstack", "--local"]);
    assert.deepEqual(stackSyncArgs(), ["stack", "sync"]);
    assert.deepEqual(stackSubmitArgs(), ["stack", "submit", "--auto"]);
    assert.deepEqual(stackLinkArgs(["first", "second"], "main"), [
      "stack",
      "link",
      "--base",
      "main",
      "--",
      "first",
      "second",
    ]);
    assert.deepEqual(stackLinkArgs(["feature"], null), ["stack", "link", "--", "feature"]);
    assert.equal(
      isMiddleInsertionRejectionOutput(
        "HTTP 422: Unprocessable Entity\n\n✗ Cannot update stack: new PRs must be added to the top of the existing stack",
      ),
      true,
    );
    assert.equal(
      isMiddleInsertionRejectionOutput(
        "Cannot update stack: new PRs must be added to the top of the existing stack (HTTP 422)",
      ),
      false,
    );
    assert.equal(
      isMiddleInsertionRejectionOutput(
        "  HTTP 422  \r\n  ✗   Cannot update stack: new PRs must be added to the top of the existing stack  \r\n  details",
      ),
      true,
    );
    assert.equal(
      isMiddleInsertionRejectionOutput(
        "prefix Cannot update stack: new PRs must be added to the top of the existing stack",
      ),
      false,
    );
    assert.equal(isMiddleInsertionRejectionOutput("remote link failed"), false);
  });

  test("injects rerere without mutating the original environment", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    const configured = withRerereGitConfig(env);

    assert.deepEqual(env, { PATH: "/bin" });
    assert.equal(configured.GIT_CONFIG_COUNT, "1");
    assert.equal(configured.GIT_CONFIG_KEY_0, "rerere.enabled");
    assert.equal(configured.GIT_CONFIG_VALUE_0, "true");
  });

  test("appends rerere after existing Git config entries", () => {
    const configured = withRerereGitConfig({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Test User",
      GIT_CONFIG_KEY_1: "core.autocrlf",
      GIT_CONFIG_VALUE_1: "false",
    });

    assert.equal(configured.GIT_CONFIG_COUNT, "3");
    assert.equal(configured.GIT_CONFIG_KEY_0, "user.name");
    assert.equal(configured.GIT_CONFIG_VALUE_0, "Test User");
    assert.equal(configured.GIT_CONFIG_KEY_1, "core.autocrlf");
    assert.equal(configured.GIT_CONFIG_VALUE_1, "false");
    assert.equal(configured.GIT_CONFIG_KEY_2, "rerere.enabled");
    assert.equal(configured.GIT_CONFIG_VALUE_2, "true");
  });

  test("recognizes stack view JSON without depending on one object shape", () => {
    assert.equal(isStackViewStacked('{"stack":[{"branch":"feature"}]}'), true);
    assert.equal(isStackViewStacked('{"currentBranch":"feature"}'), true);
    assert.equal(isStackViewStacked("[]"), false);
    assert.equal(isStackViewStacked("not json"), false);
  });

  test("extracts ordered unique branches from supported stack view shapes", () => {
    assert.deepEqual(
      stackBranchNames(
        '{"branches":[{"branch":"part-one"},{"branch":"part-two"}],"currentBranch":"part-two"}',
      ),
      ["part-one", "part-two"],
    );
    assert.deepEqual(stackBranchNames('{"stack":[{"name":"one"},{"headRefName":"two"}]}'), [
      "one",
      "two",
    ]);
    assert.deepEqual(stackBranchNames('{"branches":["one","two"]}'), ["one", "two"]);
    assert.deepEqual(stackBranchNames('["one","two"]'), ["one", "two"]);
    assert.deepEqual(
      stackBranchNames('{"branch":"two","branches":[{"branch":"one"},{"branch":"two"}]}'),
      ["one", "two"],
    );
    assert.deepEqual(stackBranchNames("not json"), []);
  });

  test("extracts trunk/base branches from root stack view fields", () => {
    assert.equal(stackBaseBranch('{"trunk":"main"}'), "main");
    assert.equal(stackBaseBranch('{"base":{"branchName":"develop"}}'), "develop");
    assert.equal(stackBaseBranch('{"trunk":{"name":"release"}}'), "release");
    assert.equal(stackBaseBranch('{"baseBranch":"main"}'), "main");
    assert.equal(stackBaseBranch('{"trunkBranch":{"headRefName":"main"}}'), "main");
    assert.equal(
      stackBaseBranch('{"stack":{"trunk":{"branch":"main"},"branches":[{"base":"abc123"}]}}'),
      "main",
    );
    assert.equal(stackBaseBranch('{"branches":[{"branch":"feature","base":"abc123"}]}'), null);
    assert.equal(stackBaseBranch('{"branches":["feature"]}'), null);
    assert.equal(stackBaseBranch("not json"), null);
  });
});

suite("enriched stack view parsing and target resolution", () => {
  const enrichedViewJson = JSON.stringify({
    trunk: "main",
    base: "main",
    currentBranch: "feature/two",
    branches: [
      {
        name: "feature/one",
        head: "sha-one",
        base: "sha-base",
        isCurrent: false,
        isMerged: true,
        isQueued: false,
        needsRebase: false,
        pr: { number: 41, url: "https://github.com/acme/repo/pull/41", state: "MERGED" },
      },
      {
        name: "feature/two",
        head: "sha-two",
        base: "sha-one",
        isCurrent: true,
        isMerged: false,
        isQueued: true,
        needsRebase: true,
        pr: { number: 42, url: "https://github.com/acme/repo/pull/42", state: "OPEN" },
      },
    ],
  });

  test("parses the enriched official view without losing order or metadata", () => {
    assert.deepEqual(parseGhStackView(enrichedViewJson), {
      trunk: "main",
      base: "main",
      currentBranch: "feature/two",
      branches: [
        {
          name: "feature/one",
          head: "sha-one",
          base: "sha-base",
          isCurrent: false,
          isMerged: true,
          isQueued: false,
          needsRebase: false,
          pr: { number: 41, url: "https://github.com/acme/repo/pull/41", state: "MERGED" },
        },
        {
          name: "feature/two",
          head: "sha-two",
          base: "sha-one",
          isCurrent: true,
          isMerged: false,
          isQueued: true,
          needsRebase: true,
          pr: { number: 42, url: "https://github.com/acme/repo/pull/42", state: "OPEN" },
        },
      ],
    });
  });

  test("accepts live-shaped branches with omitted optional fields", () => {
    assert.deepEqual(
      parseGhStackView(
        JSON.stringify({
          branches: [
            {
              name: "feature/live",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
              pr: { number: 43, state: "OPEN" },
            },
          ],
        }),
      ),
      {
        trunk: null,
        base: null,
        currentBranch: null,
        branches: [
          {
            name: "feature/live",
            head: null,
            base: null,
            isCurrent: true,
            isMerged: false,
            isQueued: false,
            needsRebase: false,
            pr: { number: 43, url: null, state: "OPEN" },
          },
        ],
      },
    );
  });

  test("resolves member branches and PR selectors, but not stack numbers", () => {
    const view = parseGhStackView(enrichedViewJson);
    assert.ok(view);
    assert.equal(resolveGhStackTarget(view, "feature/two").status, "resolved");
    assert.deepEqual(resolveGhStackTarget(view, "#41"), {
      status: "resolved",
      branch: "feature/one",
    });
    assert.equal(resolveGhStackTarget(view, "42").branch, "feature/two");
    assert.equal(
      resolveGhStackTarget(view, "https://github.com/acme/repo/pull/41").branch,
      "feature/one",
    );
    assert.equal(resolveGhStackTarget(view, "1").status, "nonmember");
    assert.equal(resolveGhStackTarget(view, "not-a-selector").status, "invalid");
  });

  test("rejects unsafe PR numbers and mismatched PR URLs", () => {
    const view = parseGhStackView(enrichedViewJson);
    assert.ok(view);
    for (const target of [
      "9007199254740992",
      "#9007199254740992",
      "https://github.com/acme/repo/pull/9007199254740992",
      "https://github.com/acme/repo/pull/41?files=1",
      "https://github.com/acme/repo/pull/41#discussion",
      "https://github.com/acme/repo/pull/41/files",
    ]) {
      assert.equal(resolveGhStackTarget(view, target).status, "invalid", target);
    }
    assert.equal(
      resolveGhStackTarget(view, "https://github.example.test/acme/repo/pull/41").status,
      "nonmember",
    );
    assert.equal(
      resolveGhStackTarget(view, "https://github.com/other/repo/pull/41").status,
      "nonmember",
    );
  });

  test("matches a valid GitHub Enterprise PR URL", () => {
    const view = parseGhStackView(
      JSON.stringify({
        branches: [
          {
            name: "feature/ghes",
            isCurrent: true,
            isMerged: false,
            isQueued: false,
            needsRebase: false,
            pr: {
              number: 41,
              url: "https://ghe.example.test/acme/repo/pull/41",
              state: "OPEN",
            },
          },
        ],
      }),
    );
    assert.ok(view);
    assert.equal(
      resolveGhStackTarget(view, "https://GHE.EXAMPLE.TEST/acme/repo/pull/41").branch,
      "feature/ghes",
    );
    assert.equal(
      resolveGhStackTarget(view, "https://ghe.example.test/acme/other/pull/41").status,
      "nonmember",
    );
  });
});

suite("GitHub stack runner-driven helpers", () => {
  test("passes checkout arguments and signal to an injected runner", async () => {
    const calls: { args: string[]; signal?: AbortSignal }[] = [];
    const signal = new AbortController().signal;
    const runner: GhStackCommandRunner = async (args, options) => {
      calls.push({ args: [...args], signal: options.signal });
      return { stdout: "checked out", stderr: "" };
    };

    const result = await runGhStackCheckout("/workspace", "resolved-branch", signal, runner);

    assert.deepEqual(calls, [{ args: ["stack", "checkout", "--", "resolved-branch"], signal }]);
    assert.deepEqual(result, { success: true, output: "checked out" });
  });

  test("passes init arguments to an injected runner", async () => {
    const calls: string[][] = [];
    const runner: GhStackCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: "created", stderr: "" };
    };

    const result = await runGhStackInit("/workspace", ["one", "two"], "main", undefined, runner);

    assert.deepEqual(calls, [["stack", "init", "--base", "main", "--", "one", "two"]]);
    assert.deepEqual(result, { success: true, output: "created" });
  });

  test("runs sync, submit, and link with official arguments", async () => {
    const calls: string[][] = [];
    const runner: GhStackCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: "ok", stderr: "" };
    };

    assert.equal((await runGhStackUnstack("/workspace", undefined, runner)).success, true);
    assert.equal((await runGhStackUnstackLocal("/workspace", undefined, runner)).success, true);
    assert.equal((await runGhStackSync("/workspace", undefined, runner)).success, true);
    assert.equal((await runGhStackSubmit("/workspace", undefined, runner)).success, true);
    assert.equal(
      (await runGhStackLink("/workspace", ["one", "two"], "main", undefined, runner)).success,
      true,
    );
    assert.deepEqual(calls, [
      ["stack", "unstack"],
      ["stack", "unstack", "--local"],
      ["stack", "sync"],
      ["stack", "submit", "--auto"],
      ["stack", "link", "--base", "main", "--", "one", "two"],
    ]);
  });

  test("distinguishes an ordinary branch from a stack probe failure", async () => {
    const ordinaryRunner: GhStackCommandRunner = async () => {
      throw new Error('current branch "feature" is not part of a stack');
    };
    assert.deepEqual(await probeGhStack("/workspace", undefined, ordinaryRunner), {
      status: "unstacked",
      output: 'current branch "feature" is not part of a stack',
      branches: [],
      baseBranch: null,
    });

    const failedRunner: GhStackCommandRunner = async () => {
      throw new Error("gh: unknown command stack");
    };
    assert.deepEqual(await probeGhStack("/workspace", undefined, failedRunner), {
      status: "error",
      output: "gh: unknown command stack",
      branches: [],
      baseBranch: null,
    });
  });

  test("recognizes successful stack probes and rejects malformed JSON", async () => {
    const stackedRunner: GhStackCommandRunner = async () => ({
      stdout: '{"trunk":"main","branches":[{"branch":"feature"}]}',
      stderr: "",
    });
    assert.deepEqual(await probeGhStack("/workspace", undefined, stackedRunner), {
      status: "stacked",
      output: '{"trunk":"main","branches":[{"branch":"feature"}]}',
      branches: ["feature"],
      baseBranch: "main",
    });

    const malformedRunner: GhStackCommandRunner = async () => ({
      stdout: "not json",
      stderr: "",
    });
    assert.equal((await probeGhStack("/workspace", undefined, malformedRunner)).status, "error");

    const incompleteRunner: GhStackCommandRunner = async () => ({
      stdout:
        '{"stack":[{"branch":"feature"}],"branches":[{"branch":"feature"},{"unknown":"base"}]}',
      stderr: "",
    });
    assert.equal((await probeGhStack("/workspace", undefined, incompleteRunner)).status, "error");
    assert.equal(isNotStackOutput("authentication failed"), false);
  });

  test("reports sync runner failures without hiding output", async () => {
    const runner: GhStackCommandRunner = async () => {
      throw new Error("rebase conflict");
    };
    const result = await runGhStackSync("/workspace", undefined, runner);
    assert.deepEqual(result, { success: false, output: "rebase conflict" });
  });
});

suite("remote stack membership probe", () => {
  const response = JSON.stringify([
    {
      id: 7,
      number: 3,
      url: "https://github.com/acme/repo/stacks/3",
      base: { ref: "main" },
      open: true,
      pull_requests: [
        {
          number: 41,
          state: "MERGED",
          draft: false,
          merged_at: "2025-01-01T00:00:00Z",
          head: { ref: "feature/one", sha: "sha-one" },
        },
        {
          number: 42,
          state: "OPEN",
          draft: true,
          merged_at: null,
          head: { ref: "feature/two", sha: "sha-two" },
        },
      ],
    },
  ]);

  test("uses the read-only API endpoint and preserves pull request order", async () => {
    const calls: string[][] = [];
    const runner: GhStackCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: response, stderr: "" };
    };
    const result = await probeGhStackRemote("/workspace", "acme", "repo", 42, undefined, runner);

    assert.deepEqual(calls, [["api", "--method", "GET", "repos/acme/repo/stacks?pull_request=42"]]);
    assert.equal(result.status, "found");
    if (result.status === "found") {
      assert.deepEqual(
        result.stack.pullRequests.map((pullRequest) => pullRequest.number),
        [41, 42],
      );
      assert.equal(result.stack.pullRequests[1].head.ref, "feature/two");
    }
  });

  test("treats malformed successful JSON as an error, not absence", async () => {
    const runner: GhStackCommandRunner = async () => ({ stdout: "{}", stderr: "warning" });
    assert.deepEqual(
      await probeGhStackRemote("/workspace", "acme", "repo", 42, undefined, runner),
      {
        status: "error",
        output: "{}warning",
      },
    );
    assert.deepEqual(stackRemoteMembershipArgs("acme", "repo", 42), [
      "api",
      "--method",
      "GET",
      "repos/acme/repo/stacks?pull_request=42",
    ]);
  });

  test("rejects invalid stack records and multiple memberships", async () => {
    const invalid = JSON.parse(response) as Record<string, unknown>[];
    (invalid[0] as Record<string, unknown>).id = 0;
    assert.equal(parseGhStackRemoteStacks(JSON.stringify(invalid)), null);

    const empty = JSON.parse(response) as Record<string, unknown>[];
    (empty[0] as Record<string, unknown>).pull_requests = [];
    assert.equal(parseGhStackRemoteStacks(JSON.stringify(empty)), null);

    const runner: GhStackCommandRunner = async () => ({
      stdout: JSON.stringify([...JSON.parse(response), JSON.parse(response)[0]]),
      stderr: "",
    });
    assert.equal(
      (await probeGhStackRemote("/workspace", "acme", "repo", 42, undefined, runner)).status,
      "error",
    );
  });
});

suite("git ls-files -u parsing", () => {
  test("deduplicates staged conflict entries and preserves paths", () => {
    assert.deepEqual(
      parseUnmergedPaths(
        "100644 aaa 1\tfile one.txt\n100644 bbb 2\tfile one.txt\n100644 ccc 3\tdir/file.ts\n",
      ),
      ["file one.txt", "dir/file.ts"],
    );
  });
});
