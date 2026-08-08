import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { Executor, InvalidActionError } from "../src/executor.ts";
import { tempRepo } from "./helpers.ts";

test("captures command output, status, duration inputs, and timeout", async () => {
  const repo = await tempRepo();
  try {
    const executor = new Executor(repo, []);
    const output = await executor.execute({
      type: "command",
      command: "printf ok; printf err >&2",
    });
    assert.equal(output.exitCode, 0);
    assert.equal(output.stdout, "ok");
    assert.equal(output.stderr, "err");
    const timeout = await executor.execute({ type: "command", command: "sleep 1", timeoutMs: 5 });
    assert.equal(timeout.timedOut, true);
  } finally {
    await rm(repo, { recursive: true });
  }
});

test("observes edits and flags effects outside allowed paths", async () => {
  const repo = await tempRepo();
  try {
    const executor = new Executor(repo, [{ path: "allowed.txt" }]);
    const result = await executor.execute({
      type: "edit",
      patch:
        "diff --git a/nope.txt b/nope.txt\nnew file mode 100644\n--- /dev/null\n+++ b/nope.txt\n@@ -0,0 +1 @@\n+nope\n",
    });
    assert.deepEqual(result.changedFiles, ["nope.txt"]);
    assert.deepEqual(result.unexpectedFiles, ["nope.txt"]);
  } finally {
    await rm(repo, { recursive: true });
  }
});

test("rejects malformed and non-executable actions", async () => {
  const executor = new Executor(await tempRepo(), []);
  await assert.rejects(
    () => executor.execute({ type: "ask_user", question: "?" }),
    InvalidActionError,
  );
});
