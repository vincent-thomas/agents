import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
        "const matches = [...ctx.context.matchAll(/NEEDLE/g)]; ctx.console.log(matches.length)",
      );
      const second = await runtime.execute("ctx.console.log(matches[0][0])");
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
        'ctx.console.log(await Promise.all([ctx.llm("one", ctx.context.slice(0, 2)), ctx.llm("two", ctx.context.slice(2, 4))]))',
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
      const result = await second.execute("ctx.console.log(typeof privateValue)");
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
        "ctx.console.log(typeof context, typeof llm, typeof console, typeof process, typeof require, typeof fetch, typeof Buffer, typeof setTimeout)",
      );
      assert.equal(
        result.output,
        "undefined undefined undefined undefined undefined undefined undefined undefined",
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
    const runtime = new JavaScriptRuntime({ context: "", llm: async () => "" });
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
    const runtime = new JavaScriptRuntime({ context: "", llm: async () => "" });
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
    const runtime = new JavaScriptRuntime({ context: "", llm: async () => "" });
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

    const runtime = new JavaScriptRuntime({ context: "", llm: async () => "" });
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

  test("hard-stops programs that exceed the timeout", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      llm: async () => "",
      executionTimeoutMs: 100,
    });
    await assert.rejects(runtime.execute("while (true) {}"), /exceeded 100ms timeout/);
  });

  test("truncates console output", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      llm: async () => "",
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
