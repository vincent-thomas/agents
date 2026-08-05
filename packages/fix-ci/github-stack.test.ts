import assert from "node:assert/strict";
import { suite, test } from "node:test";
import {
  isNotStackOutput,
  isStackViewStacked,
  probeGhStack,
  runGhStackInit,
  runGhStackUnstackLocal,
  runGhStackSubmit,
  runGhStackSync,
  stackBaseBranch,
  stackBranchNames,
  stackInitArgs,
  stackSubmitArgs,
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

  test("builds official view, sync, and submit commands", () => {
    assert.deepEqual(stackViewArgs(), ["stack", "view", "--json"]);
    assert.deepEqual(stackUnstackLocalArgs(), ["stack", "unstack", "--local"]);
    assert.deepEqual(stackSyncArgs(), ["stack", "sync"]);
    assert.deepEqual(stackSubmitArgs(), ["stack", "submit", "--auto"]);
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

suite("GitHub stack runner-driven helpers", () => {
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

  test("runs sync then submit with official arguments", async () => {
    const calls: string[][] = [];
    const runner: GhStackCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: "ok", stderr: "" };
    };

    assert.equal((await runGhStackUnstackLocal("/workspace", undefined, runner)).success, true);
    assert.equal((await runGhStackSync("/workspace", undefined, runner)).success, true);
    assert.equal((await runGhStackSubmit("/workspace", undefined, runner)).success, true);
    assert.deepEqual(calls, [
      ["stack", "unstack", "--local"],
      ["stack", "sync"],
      ["stack", "submit", "--auto"],
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
