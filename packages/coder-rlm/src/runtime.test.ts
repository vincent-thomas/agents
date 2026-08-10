import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { suite, test } from "node:test";
import { JavaScriptRuntime, type JavaScriptRuntimeRLM } from "./runtime.ts";
import type { RLMChildHandle, RLMChildResult } from "./child-types.ts";

function testHandle(id: number, name = `child-${id}`): RLMChildHandle {
  return { id, name, parentRunId: 0, depth: 1 };
}
function testResult(handle: RLMChildHandle, text = "child result"): RLMChildResult {
  return { handle, status: "succeeded", text };
}
function testRlm(): JavaScriptRuntimeRLM {
  return {
    spawn: async (prompt, options) => testHandle(prompt === "one" ? 1 : 2, options?.name),
    waitAll: async (handles) => handles.map((handle) => testResult(handle)),
    result: async (handle) => ({ handle, status: "pending" }),
    cancel: async (handle) => ({ handle, status: "cancelled" }),
  };
}

suite("JavaScriptRuntime", () => {
  test("inspects external context and preserves declarations", async () => {
    const runtime = new JavaScriptRuntime({
      context: "NEEDLE x NEEDLE",
      rlm: testRlm(),
    });
    try {
      const first = await runtime.execute(
        "const matches = [...ctx.context.matchAll(/NEEDLE/g)]; ctx.console.log(matches.length)",
      );
      const second = await runtime.execute("ctx.console.log(matches[0][0])");
      assert.equal(first.output, "2");
      assert.equal(second.output, "NEEDLE");
    } finally {
      runtime.dispose();
    }
  });

  test("supports await, parallel child calls, and delegated context", async () => {
    const calls: Array<{ prompt: string; context?: string }> = [];
    const handles = [testHandle(1, "one"), testHandle(2, "two")];
    const runtime = new JavaScriptRuntime({
      context: "abcdefgh",
      rlm: {
        spawn: async (prompt, options) => {
          calls.push({ prompt, context: options?.context });
          return handles[prompt === "one" ? 0 : 1];
        },
        waitAll: async (children) =>
          children.map((child) => testResult(child, child.name === "one" ? "one:ab" : "two:cd")),
        result: async (child) => testResult(child),
        cancel: async (child) => ({ handle: child, status: "cancelled" }),
      },
    });
    try {
      const result = await runtime.execute(
        'const handles = await Promise.all([ctx.rlm.spawn("one", { context: ctx.context.slice(0, 2) }), ctx.rlm.spawn("two", { context: ctx.context.slice(2, 4) })]); ctx.console.log((await ctx.rlm.waitAll(handles)).map((result) => result.text))',
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

  test("reads current child results and cancels through the host protocol", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(
        'const h = await ctx.rlm.spawn("inspect", { name: "worker" }); const before = await ctx.rlm.result(h); const after = await ctx.rlm.cancel(h); ctx.console.log(h.name, before.status, after.status)',
      );
      assert.equal(result.output, "worker pending cancelled");
    } finally {
      runtime.dispose();
    }
  });

  test("does not share variables between runtimes", async () => {
    const first = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    const second = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      await first.execute("const privateValue = 42");
      const result = await second.execute("ctx.console.log(typeof privateValue)");
      assert.equal(result.output, "undefined");
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  test("omits host capabilities", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(
        "ctx.console.log(typeof context, typeof llm, typeof rlm, typeof console, typeof process, typeof require, typeof fetch, typeof Buffer, typeof setTimeout)",
      );
      assert.equal(
        result.output,
        "undefined undefined undefined undefined undefined undefined undefined undefined undefined",
      );
      const imported = await runtime.execute('await import("node:fs")');
      assert.deepEqual(imported.error, {
        name: "Error",
        message: "Dynamic import is disabled: node:fs",
      });
      assert.equal((await runtime.execute('ctx.console.log("alive")')).output, "alive");
    } finally {
      runtime.dispose();
    }
  });

  test("returns exceptions without destroying the runtime", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const failed = await runtime.execute('ctx.console.error("before"); throw new Error("boom")');
      assert.deepEqual(failed.error, { name: "Error", message: "boom" });
      assert.equal(failed.output, "[error] before");
      assert.equal((await runtime.execute('ctx.console.log("alive")')).output, "alive");
    } finally {
      runtime.dispose();
    }
  });

  test("reads working-directory files and selected lines through ctx.fs", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(`
        const full = ctx.fs.read("./packages/coder-rlm/package.json");
        const first = ctx.fs.read("./packages/coder-rlm/package.json:1");
        const range = ctx.fs.read("./packages/coder-rlm/package.json:1-3");
        ctx.console.log(
          full.includes('"name": "@vt-agent/coder-rlm"'),
          first === "{",
          range === '{\\n  "name": "@vt-agent/coder-rlm",\\n  "version": "0.0.0",',
          typeof ctx.fs.write,
          Object.isFrozen(ctx.fs),
          Object.isFrozen(ctx),
        );
      `);
      assert.equal(result.output, "true true true undefined true true");
    } finally {
      runtime.dispose();
    }
  });

  test("rejects unsafe and malformed fs selectors", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(`
        const selectors = [
          "../package.json",
          "./../package.json",
          "/etc/passwd",
          "./packages/coder-rlm/package.json:0",
          "./packages/coder-rlm/package.json:-1",
          "./packages/coder-rlm/package.json:3-2",
          "./packages/coder-rlm/package.json:abc",
        ];
        const rejected = selectors.every((selector) => {
          try {
            ctx.fs.read(selector);
            return false;
          } catch {
            return true;
          }
        });
        ctx.console.log(rejected);
      `);
      assert.equal(result.output, "true");
    } finally {
      runtime.dispose();
    }
  });

  test("rejects symlinks to files outside the working directory", async () => {
    const insideDirectory = mkdtempSync(join(process.cwd(), ".rlm-runtime-test-"));
    const outsideDirectory = mkdtempSync(join(tmpdir(), "rlm-runtime-test-"));
    const outsideFile = join(outsideDirectory, "secret.txt");
    const link = join(insideDirectory, "escape.txt");
    writeFileSync(outsideFile, "outside");
    symlinkSync(outsideFile, link);

    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const selector = `./${relative(process.cwd(), link)}`;
      const result = await runtime.execute(`ctx.fs.read(${JSON.stringify(selector)})`);
      assert.deepEqual(result.error, {
        name: "Error",
        message: "ctx.fs.read() path is outside the working directory",
      });
    } finally {
      runtime.dispose();
      rmSync(insideDirectory, { recursive: true, force: true });
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  test("hard-stops programs that exceed the stall timeout", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      rlm: testRlm(),
      javascriptStallTimeoutMs: 100,
    });
    await assert.rejects(runtime.execute("while (true) {}"), /exceeded 100ms stall timeout/);
  });

  test("times out unresolved JavaScript without a pending host wait", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      rlm: testRlm(),
      javascriptStallTimeoutMs: 100,
    });
    await assert.rejects(
      runtime.execute("await new Promise(() => {})"),
      /exceeded 100ms stall timeout/,
    );
  });

  test("starting a child does not exempt a synchronous stall", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      rlm: testRlm(),
      javascriptStallTimeoutMs: 100,
    });
    await assert.rejects(
      runtime.execute('ctx.rlm.spawn("child"); while (true) {}'),
      /exceeded 100ms stall timeout/,
    );
  });

  test("aborts recursive calls when an execution times out", async () => {
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const runtime = new JavaScriptRuntime({
      context: "",
      javascriptStallTimeoutMs: 100,
      rlm: {
        ...testRlm(),
        spawn: async (_prompt, _options, signal) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => {
                resolveAborted();
                reject(new DOMException("child aborted", "AbortError"));
              },
              { once: true },
            ),
          ),
      },
    });

    await assert.rejects(
      runtime.execute('await ctx.rlm.spawn("never finishes")'),
      /exceeded 100ms stall timeout/,
    );
    await aborted;
  });

  test("concurrent waitAll latency does not trigger the stall watchdog", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      rlm: {
        ...testRlm(),
        waitAll: async (handles) => {
          await new Promise((resolve) => setTimeout(resolve, 700));
          return handles.map((child) => testResult(child, "done"));
        },
      },
      javascriptStallTimeoutMs: 500,
    });
    try {
      const result = await runtime.execute(
        'const h = await ctx.rlm.spawn("slow"); const waits = await Promise.all([ctx.rlm.waitAll([h]), ctx.rlm.waitAll([h])]); waits[1][0].text',
      );
      assert.equal(result.output, "[result] done");
    } finally {
      runtime.dispose();
    }
  });

  test("truncates console output", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      rlm: testRlm(),
      maxOutputChars: 100,
    });
    try {
      const result = await runtime.execute('ctx.console.log("x".repeat(1_000))');
      assert.ok(result.output.length <= 100);
      assert.match(result.output, /output truncated/);
    } finally {
      runtime.dispose();
    }
  });
});
