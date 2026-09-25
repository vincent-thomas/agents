import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { suite, test } from "node:test";
import { InProcessJavaScriptRuntime } from "./in-process-runtime.ts";
import { createReadOnlyContextFacade } from "./membrane.ts";
import { JavaScriptRuntime, type JavaScriptRuntimeRLM } from "./runtime.ts";
import type { RLMChildHandle, RLMChildResult } from "./child-types.ts";

function testHandle(
  id: number,
  name = `child-${id}`,
  tier: RLMChildHandle["tier"] = "balanced",
): RLMChildHandle {
  return { id, name, parentRunId: 0, depth: 1, tier };
}
function testResult(handle: RLMChildHandle, text = "child result"): RLMChildResult {
  return { handle, tier: handle.tier, status: "succeeded", text };
}
function testRlm(): JavaScriptRuntimeRLM {
  return {
    spawn: async (prompt, options) =>
      testHandle(prompt === "one" ? 1 : 2, options?.name, options?.tier),
    waitAll: async (handles) => handles.map((handle) => testResult(handle)),
    result: async (handle) => ({ handle, tier: handle.tier, status: "pending" }),
    cancel: async (handle) => ({ handle, tier: handle.tier, status: "cancelled" }),
  };
}

suite("JavaScriptRuntime", () => {
  test("read-only context facade membranes root traps, cycles, accessors, and returns", async () => {
    const symbol = Symbol("secret");
    let setterCalls = 0;
    const source: any = {
      nested: { value: 1 },
      self: undefined,
      [symbol]: "symbol",
      get answer() {
        return this.nested.value;
      },
      set answer(_value: number) {
        setterCalls += 1;
      },
      method(value: any) {
        this.nested.value += value.nested.value;
        return this;
      },
      async returned() {
        return { source: this };
      },
    };
    source.self = source;
    source.list = [{ root: source }];
    Object.defineProperty(source, "fixed", { value: { root: source }, enumerable: true });
    const facade = createReadOnlyContextFacade(source) as any;

    assert.notEqual(facade, source);
    assert.equal(Object.getPrototypeOf(facade), null);
    assert.deepEqual(Reflect.ownKeys(facade), Reflect.ownKeys(source));
    assert.equal(Reflect.get(facade, symbol), "symbol");
    assert.equal(Reflect.getOwnPropertyDescriptor(facade, "fixed")?.configurable, true);
    assert.equal(Reflect.getOwnPropertyDescriptor(facade, "self")?.value, facade);
    const answerDescriptor = Reflect.getOwnPropertyDescriptor(facade, "answer")!;
    assert.equal(answerDescriptor.get!(), 1);
    assert.equal(answerDescriptor.set, undefined);
    assert.throws(() => Reflect.set(facade, "answer", 4), TypeError);
    assert.equal(setterCalls, 0);
    assert.throws(() => Reflect.deleteProperty(facade, "nested"), TypeError);
    assert.throws(() => Reflect.defineProperty(facade, "newKey", { value: 1 }), TypeError);
    assert.throws(() => Reflect.setPrototypeOf(facade, {}), TypeError);
    assert.throws(() => Reflect.preventExtensions(facade), TypeError);

    facade.nested.value = 3;
    assert.equal(source.nested.value, 3);
    assert.equal(facade.self, facade);
    assert.equal(facade.list.map((item: any) => item.root === facade)[0], true);
    assert.equal(facade.method(facade), facade);
    assert.equal(source.nested.value, 6);
    const returned = await facade.returned();
    assert.equal(returned.source, facade);
    returned.extra = true;
    assert.equal(returned.extra, true);
  });

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
        cancel: async (child) => ({ handle: child, tier: child.tier, status: "cancelled" }),
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

  test("clones RLM result objects into frozen null-prototype values", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      rlm: {
        ...testRlm(),
        result: async () =>
          ({
            nested: { value: 7, values: [{ value: "a" }, { value: "b" }] },
          }) as RLMChildResult,
      },
    });
    try {
      const result = await runtime.execute(`
        const value = await ctx.rlm.result(await ctx.rlm.spawn("inspect"));
        let blocked = false;
        try { value.constructor.constructor("return process")(); } catch { blocked = true; }
        ctx.console.log(
          blocked,
          Object.getPrototypeOf(value) === null,
          Object.isFrozen(value),
          Object.getPrototypeOf(value.nested) === null,
          Object.isFrozen(value.nested),
          Object.isFrozen(value.nested.values),
          value.nested.values.map((item) => item.value).join(","),
        );
      `);
      assert.equal(result.output, "true true true true true true a,b");
      assert.equal(
        (await runtime.execute('ctx.console.log("result boundary alive")')).output,
        "result boundary alive",
      );
    } finally {
      runtime.dispose();
    }
  });

  test("keeps waitAll arrays usable without exposing host constructors", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(`
        const handle = await ctx.rlm.spawn("inspect");
        const values = await ctx.rlm.waitAll([handle]);
        let blocked = false;
        try { values.constructor.constructor("return process")(); } catch { blocked = true; }
        ctx.console.log(
          blocked,
          Array.isArray(values),
          values.length,
          values[0].status,
          values.map((item) => item.status).join(","),
          Object.isFrozen(values),
          typeof values.constructor === "function",
        );
      `);
      assert.equal(result.output, "true true 1 succeeded succeeded true true");
      assert.equal(
        (await runtime.execute('ctx.console.log("array boundary alive")')).output,
        "array boundary alive",
      );
    } finally {
      runtime.dispose();
    }
  });

  test("does not expose host inspection functions to sandbox values", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(`
        let customInspectCalled = false;
        const value = {
          [Symbol.for("nodejs.util.inspect.custom")](_depth, _options, inspect) {
            customInspectCalled = true;
            return "HOST_PROCESS_" + inspect.constructor("return process")().pid;
          },
        };
        ctx.console.log(value);
        ctx.console.log("custom-called", customInspectCalled);
      `);
      assert.match(result.output, /custom-called false/);
      assert.doesNotMatch(result.output, /HOST_PROCESS_\d+/);
      assert.equal(
        (await runtime.execute('ctx.console.log("inspect boundary alive")')).output,
        "inspect boundary alive",
      );
    } finally {
      runtime.dispose();
    }
  });

  test("chains safe thenables without assimilating sandbox callback results", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(`
        const name = await ctx.rlm
          .spawn("inspect", { name: "worker" })
          .then((handle) => handle.name)
          .then((value) => value.toUpperCase());
        ctx.console.log(name);
      `);
      assert.equal(result.output, "WORKER");
    } finally {
      runtime.dispose();
    }
  });

  test("does not assimilate sandbox callback or handle thenables", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(`
        const handle = await ctx.rlm.spawn("inspect");
        let callbackThenInvoked = false;
        const pending = ctx.rlm.result(handle);
        pending.then(() => ({
          then(resolve) {
            callbackThenInvoked = true;
            resolve.constructor("return process")();
          },
        }));
        await pending;
        await Promise.resolve();

        let handleThenInvoked = false;
        const hostileHandle = {
          ...handle,
          then(resolve) {
            handleThenInvoked = true;
            resolve.constructor("return process")();
          },
        };
        await ctx.rlm.result(hostileHandle);
        ctx.console.log(callbackThenInvoked, handleThenInvoked);
      `);
      assert.equal(result.output, "false false");
      assert.equal(
        (await runtime.execute('ctx.console.log("thenable boundary alive")')).output,
        "thenable boundary alive",
      );
    } finally {
      runtime.dispose();
    }
  });

  test("copies only validated protocol fields from cyclic sandbox payloads", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(`
        const options = { name: "safe", tier: "fast" };
        options.self = options;
        const handle = await ctx.rlm.spawn("inspect", options);
        const forged = { ...handle };
        forged.self = forged;
        const child = await ctx.rlm.result(forged);
        let safeBigIntError = false;
        try {
          await ctx.rlm.result({ ...handle, id: 1n });
        } catch (error) {
          safeBigIntError = error.constructor === undefined;
        }
        ctx.console.log(handle.name, handle.tier, child.status, safeBigIntError);
      `);
      assert.equal(result.output, "safe fast pending true");
    } finally {
      runtime.dispose();
    }
  });

  test("keeps RLM rejections as safe error-like values", async () => {
    const runtime = new JavaScriptRuntime({
      context: "",
      rlm: {
        ...testRlm(),
        spawn: async () => {
          throw Object.assign(new Error("child operation failed"), { name: "ChildError" });
        },
      },
    });
    try {
      const result = await runtime.execute(`
        try {
          await ctx.rlm.spawn("reject");
        } catch (error) {
          ctx.console.log(error.name, error.message, error.constructor === undefined);
        }
      `);
      assert.equal(result.output, "ChildError child operation failed true");
      assert.equal(
        (await runtime.execute('ctx.console.log("rejection boundary alive")')).output,
        "rejection boundary alive",
      );
    } finally {
      runtime.dispose();
    }
  });

  test("keeps fs and validation errors safe and useful", async () => {
    const runtime = new JavaScriptRuntime({ context: "", rlm: testRlm() });
    try {
      const result = await runtime.execute(`
        const errors = [];
        for (const operation of [
          () => ctx.fs.read("./does-not-exist.txt"),
          () => ctx.fs.read(42),
          () => ctx.rlm.spawn(""),
        ]) {
          try {
            operation();
          } catch (error) {
            errors.push([error.name, error.message, error.constructor === undefined]);
          }
        }
        ctx.console.log(
          errors.map((error) => error[0] + ":" + error[2]).join(","),
          errors[0][1].includes("ENOENT"),
          errors[1][1],
          errors[2][1],
        );
      `);
      assert.equal(
        result.output,
        "Error:true,TypeError:true,TypeError:true true ctx.fs.read() selector must be a string ctx.rlm.spawn() prompt must be a non-empty string",
      );
      assert.equal(
        (await runtime.execute('ctx.console.log("error boundary alive")')).output,
        "error boundary alive",
      );
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

  test("custom in-process runtime exposes a live read-only root facade", async () => {
    class Widget {
      value = 4;
      get doubled() {
        return this.value * 2;
      }
    }
    const symbol = Symbol("value");
    const ctx: any = {
      count: 1,
      self: undefined,
      widget: new Widget(),
      nested: { value: 2 },
      callback(value: unknown) {
        this.received = value;
        return this === value;
      },
      async increment(value: number) {
        await Promise.resolve();
        return { value: value + 1, self: this };
      },
    };
    ctx[symbol] = "symbol";
    ctx.self = ctx;
    const runtime = new InProcessJavaScriptRuntime({ ctx, context: "ignored", rlm: testRlm() });
    try {
      assert.equal(
        (
          await runtime.execute(
            "Object.getPrototypeOf(ctx) === null && ctx.self === ctx && ctx.widget.doubled === 8 && Reflect.get(ctx, Reflect.ownKeys(ctx).find((key) => typeof key === 'symbol')) === 'symbol'",
          )
        ).output,
        "[result] true",
      );
      assert.equal(
        (await runtime.execute("ctx.self === ctx && Reflect.ownKeys(ctx).length > 0")).output,
        "[result] true",
      );
      assert.equal((await runtime.execute("ctx.callback(ctx)")).output, "[result] true");
      assert.equal(ctx.received, ctx);
      assert.equal(
        (await runtime.execute("(() => { ctx.nested.value = 7; return ctx.nested.value; })()"))
          .output,
        "[result] 7",
      );
      assert.equal(ctx.nested.value, 7);
      assert.equal((await runtime.execute("ctx.count = 12")).error?.name, "TypeError");
      assert.equal(ctx.count, 1);
      assert.equal(
        (await runtime.execute("ctx.widget.constructor.name")).output,
        "[result] Widget",
      );
      const incremented = await runtime.execute("await ctx.increment(4)");
      assert.match(incremented.output, /value: 5/);
      assert.match(incremented.output, /self:/);
      assert.equal((await runtime.execute("ctx.count")).output, "[result] 1");
      ctx.count = 9;
      assert.equal((await runtime.execute("ctx.count")).output, "[result] 9");
      assert.equal(
        (
          await runtime.execute(
            "Reflect.get(ctx, Reflect.ownKeys(ctx).find((key) => typeof key === 'symbol'))",
          )
        ).output,
        "[result] symbol",
      );
      assert.equal(
        (await runtime.execute("const local = 5")).output,
        "JavaScript completed with no output.",
      );
      assert.equal((await runtime.execute("typeof local")).output, "[result] undefined");
      assert.equal(
        (await runtime.execute("typeof context + ' ' + typeof rlm + ' ' + typeof console")).output,
        "[result] undefined undefined undefined",
      );
    } finally {
      runtime.dispose();
    }
  });

  test("in-process runtime preserves cross-realm error names and remains usable", async () => {
    const runtime = new InProcessJavaScriptRuntime({ ctx: {}, context: "", rlm: testRlm() });
    try {
      const failed = await runtime.execute('throw new TypeError("boom")');
      assert.deepEqual(failed.error, { name: "TypeError", message: "boom" });
      assert.equal((await runtime.execute('"alive"')).output, "[result] alive");
    } finally {
      runtime.dispose();
    }
  });

  test("disposing an in-process runtime rejects a pending asynchronous cell", async () => {
    let startedResolve!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const ctx: { wait: () => Promise<string>; state: { late?: boolean } } = {
      state: {},
      wait: async () => {
        startedResolve();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "late";
      },
    };
    const runtime = new InProcessJavaScriptRuntime({ ctx, context: "", rlm: testRlm() });
    const execution = runtime.execute("await ctx.wait(); ctx.state.late = true");
    await started;
    runtime.dispose();
    await assert.rejects(execution, /disposed/);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ctx.state.late, true);
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
