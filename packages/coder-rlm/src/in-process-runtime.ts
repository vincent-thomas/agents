import { formatWithOptions } from "node:util";
import type { RLMContext } from "./context.ts";
import type {
  JavaScriptExecutionResult,
  JavaScriptRuntimeOptions,
  JavaScriptRuntimeLike,
} from "./runtime.ts";

/**
 * An intentionally unsafe runtime for caller-owned contexts. Generated code
 * executes directly in the host realm with the supplied object as its ctx
 * argument, preserving exact identity and ordinary JavaScript semantics. This
 * is trusted-code execution, not a security boundary.
 */
export class InProcessJavaScriptRuntime implements JavaScriptRuntimeLike {
  private readonly ctx: RLMContext;
  private readonly maxOutputChars: number;
  private readonly ownerSignal: AbortSignal | undefined;
  private readonly stallTimeoutMs: number;
  private queue: Promise<void> = Promise.resolve();
  private active: ActiveExecution | undefined;
  private closed = false;

  constructor(options: JavaScriptRuntimeOptions & { ctx: RLMContext }) {
    if (typeof options.ctx !== "object" || options.ctx === null) {
      throw new TypeError("ctx must be a non-null object when provided");
    }
    this.maxOutputChars = positiveInteger(options.maxOutputChars ?? 50_000, "maxOutputChars");
    this.stallTimeoutMs = positiveInteger(
      options.javascriptStallTimeoutMs ?? 60_000,
      "javascriptStallTimeoutMs",
    );
    this.ownerSignal = options.signal;
    this.ctx = options.ctx;
  }

  execute(code: string, signal?: AbortSignal): Promise<JavaScriptExecutionResult> {
    if (typeof code !== "string") return Promise.reject(new TypeError("code must be a string"));
    const run = this.queue.then(() => this.executeOnce(code, signal));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.active?.terminate(new Error("JavaScript runtime was disposed"));
    this.active = undefined;
  }

  private executeOnce(code: string, signal?: AbortSignal): Promise<JavaScriptExecutionResult> {
    if (this.closed) return Promise.reject(new Error("JavaScript runtime is closed"));
    if (signal?.aborted || this.ownerSignal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.ownerSignal?.removeEventListener("abort", onOwnerAbort);
        if (this.active === active) this.active = undefined;
      };
      const finish = (error: unknown, value?: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) {
          const failure = asError(error);
          resolve({
            output: "JavaScript completed with no output.",
            error: { name: failure.name || "Error", message: failure.message || String(failure) },
          });
          return;
        }
        resolve({ output: outputText(value, this.maxOutputChars) });
      };
      const terminate = (error: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };
      const active: ActiveExecution = { terminate };
      const onAbort = () => {
        terminate(abortError());
        this.dispose();
      };
      const onOwnerAbort = () => {
        terminate(abortError());
        this.dispose();
      };
      this.active = active;
      timer = setTimeout(() => {
        terminate(
          new Error(
            `JavaScript execution exceeded ${this.stallTimeoutMs}ms stall timeout; custom ctx execution is in-process and synchronous code cannot be interrupted`,
          ),
        );
        this.dispose();
      }, this.stallTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.ownerSignal?.addEventListener("abort", onOwnerAbort, { once: true });
      let evaluation: unknown;
      try {
        evaluation = evaluateCode(code, this.ctx);
      } catch (error) {
        finish(error);
        return;
      }
      void Promise.resolve(evaluation).then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  }
}

type ActiveExecution = { terminate: (error: Error) => void };

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as FunctionConstructor;
const CELL_ARGUMENTS = ["ctx", "context", "rlm", "console"] as const;

type CellFunction = (
  ctx: RLMContext,
  context: undefined,
  rlm: undefined,
  console: undefined,
) => unknown;

function evaluateCode(code: string, ctx: RLMContext): unknown {
  let cell: CellFunction;
  try {
    cell = new Function(...CELL_ARGUMENTS, `"use strict"; return (\n${code}\n);`) as CellFunction;
  } catch (expressionError) {
    if (!isSyntaxError(expressionError)) throw expressionError;
    try {
      cell = new Function(...CELL_ARGUMENTS, `"use strict";\n${code}\n`) as CellFunction;
    } catch (statementError) {
      if (!isSyntaxError(statementError) || !/\bawait\b/.test(code)) throw statementError;
      cell = compileAsyncCell(code);
    }
  }
  return cell(ctx, undefined, undefined, undefined);
}

function compileAsyncCell(code: string): CellFunction {
  try {
    return new AsyncFunction(
      ...CELL_ARGUMENTS,
      `"use strict"; return (\n${code}\n);`,
    ) as CellFunction;
  } catch (expressionError) {
    if (!isSyntaxError(expressionError)) throw expressionError;
    return new AsyncFunction(...CELL_ARGUMENTS, `"use strict";\n${code}\n`) as CellFunction;
  }
}

function isSyntaxError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error !== null &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "SyntaxError")
  );
}

function outputText(value: unknown, maximum: number): string {
  if (value === undefined) return "JavaScript completed with no output.";
  const text = `[result] ${formatValue(value, maximum)}`;
  if (text.length <= maximum) return text;
  const marker = `\n[output truncated at ${maximum} characters]`;
  return `${text.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

function formatValue(value: unknown, max: number): string {
  return formatWithOptions(
    {
      colors: false,
      compact: 3,
      depth: 5,
      maxArrayLength: 100,
      maxStringLength: Math.min(max, 20_000),
      customInspect: false,
      getters: false,
      breakLength: 100,
    },
    value,
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === "object") {
    try {
      const name =
        typeof (error as { name?: unknown }).name === "string"
          ? (error as { name: string }).name
          : "Error";
      const message =
        typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error);
      return Object.assign(new Error(message), { name });
    } catch {
      return new Error("Unknown error");
    }
  }
  return new Error(String(error));
}

function abortError(): DOMException {
  return new DOMException("JavaScript execution aborted", "AbortError");
}
