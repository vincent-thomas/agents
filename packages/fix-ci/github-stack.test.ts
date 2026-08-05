import assert from "node:assert/strict";
import { suite, test } from "node:test";
import {
  isNotStackOutput,
  isStackViewStacked,
  probeGhStack,
  runGhStackInit,
  runGhStackSubmit,
  runGhStackSync,
  stackInitArgs,
  stackSubmitArgs,
  stackSyncArgs,
  stackViewArgs,
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
    assert.deepEqual(stackSyncArgs(), ["stack", "sync"]);
    assert.deepEqual(stackSubmitArgs(), ["stack", "submit", "--auto"]);
  });

  test("recognizes stack view JSON without depending on one object shape", () => {
    assert.equal(isStackViewStacked('{"stack":[{"branch":"feature"}]}'), true);
    assert.equal(isStackViewStacked('{"currentBranch":"feature"}'), true);
    assert.equal(isStackViewStacked("[]"), false);
    assert.equal(isStackViewStacked("not json"), false);
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

    assert.equal((await runGhStackSync("/workspace", undefined, runner)).success, true);
    assert.equal((await runGhStackSubmit("/workspace", undefined, runner)).success, true);
    assert.deepEqual(calls, [
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
    });

    const failedRunner: GhStackCommandRunner = async () => {
      throw new Error("gh: unknown command stack");
    };
    assert.deepEqual(await probeGhStack("/workspace", undefined, failedRunner), {
      status: "error",
      output: "gh: unknown command stack",
    });
  });

  test("recognizes successful stack probes and rejects malformed JSON", async () => {
    const stackedRunner: GhStackCommandRunner = async () => ({
      stdout: '{"branches":[{"branch":"feature"}]}',
      stderr: "",
    });
    assert.equal((await probeGhStack("/workspace", undefined, stackedRunner)).status, "stacked");

    const malformedRunner: GhStackCommandRunner = async () => ({
      stdout: "not json",
      stderr: "",
    });
    assert.equal((await probeGhStack("/workspace", undefined, malformedRunner)).status, "error");
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
