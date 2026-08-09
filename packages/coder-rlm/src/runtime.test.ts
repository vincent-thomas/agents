import assert from "node:assert/strict";
import { suite, test } from "node:test";
import { JavaScriptRuntime } from "./runtime.ts";

suite("JavaScriptRuntime", () => {
  test("inspects external context and preserves declarations", async () => {
    const runtime = new JavaScriptRuntime({
      context: "NEEDLE x NEEDLE",
      llm: async () => "unused",
    });
    try {
      const first = await runtime.execute(
        "const matches = [...context.matchAll(/NEEDLE/g)]; console.log(matches.length)",
      );
      const second = await runtime.execute("console.log(matches[0][0])");
      assert.equal(first.output, "2");
      assert.equal(second.output, "NEEDLE");
    } finally {
      runtime.dispose();
    }
  });

  test("supports await, parallel llm calls, and delegated context", async () => {
    const calls: Array<{ prompt: string; context?: string }> = [];
    const runtime = new JavaScriptRuntime({
      context: "abcdefgh",
      llm: async (prompt, context) => {
        calls.push({ prompt, context });
        return `${prompt}:${context}`;
      },
    });
    try {
      const result = await runtime.execute(
        'console.log(await Promise.all([llm("one", context.slice(0, 2)), llm("two", context.slice(2, 4))]))',
      );
      assert.match(result.output, /one:ab/);
      assert.match(result.output, /two:cd/);
      assert.deepEqual(calls, [
        { prompt: "one", context: "ab" },
        { prompt: "two", context: "cd" },
      ]);
    } finally {
      runtime.dispose();
    }
  });

  test("does not share variables between runtimes", async () => {
    const first = new JavaScriptRuntime({ context: "", llm: async () => "" });
    const second = new JavaScriptRuntime({ context: "", llm: async () => "" });
    try {
      await first.execute("const privateValue = 42");
      const result = await second.execute("console.log(typeof privateValue)");
      assert.equal(result.output, "undefined");
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  test("omits host capabilities", async () => {
    const runtime = new JavaScriptRuntime({ context: "", llm: async () => "" });
    try {
      const result = await runtime.execute(
        "console.log(typeof process, typeof require, typeof fetch, typeof Buffer, typeof setTimeout)",
      );
      assert.equal(result.output, "undefined undefined undefined undefined undefined");
      const imported = await runtime.execute('await import("node:fs")');
      assert.deepEqual(imported.error, {
        name: "Error",
        message: "Dynamic import is disabled: node:fs",
      });
      assert.equal((await runtime.execute('console.log("alive")')).output, "alive");
    } finally {
      runtime.dispose();
    }
  });

  test("returns exceptions without destroying the runtime", async () => {
    const runtime = new JavaScriptRuntime({ context: "", llm: async () => "" });
    try {
      const failed = await runtime.execute('console.error("before"); throw new Error("boom")');
      assert.deepEqual(failed.error, { name: "Error", message: "boom" });
      assert.equal(failed.output, "[error] before");
      assert.equal((await runtime.execute('console.log("alive")')).output, "alive");
    } finally {
      runtime.dispose();
    }
  });

  test("hard-stops programs that exceed the timeout", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      llm: async () => "",
      executionTimeoutMs: 100,
    });
    await assert.rejects(runtime.execute("while (true) {}"), /exceeded 100ms timeout/);
  });

  test("aborts recursive calls when an execution times out", async () => {
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const runtime = new JavaScriptRuntime({
      context: "",
      executionTimeoutMs: 100,
      llm: async (_prompt, _context, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolveAborted();
              reject(new DOMException("child aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    });

    await assert.rejects(runtime.execute('await llm("never finishes")'), /exceeded 100ms timeout/);
    await aborted;
  });

  test("truncates console output", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      llm: async () => "",
      maxOutputChars: 100,
    });
    try {
      const result = await runtime.execute('console.log("x".repeat(1_000))');
      assert.ok(result.output.length <= 100);
      assert.match(result.output, /output truncated/);
    } finally {
      runtime.dispose();
    }
  });
});
