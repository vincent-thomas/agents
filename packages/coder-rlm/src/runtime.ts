import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

export interface JavaScriptExecutionResult {
  output: string;
  error?: {
    name: string;
    message: string;
  };
}

export interface JavaScriptRuntimeOptions {
  context: string;
  llm: (prompt: string, context?: string) => Promise<string>;
  executionTimeoutMs?: number;
  maxOutputChars?: number;
}

interface PendingExecution {
  resolve: (result: JavaScriptExecutionResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

export class JavaScriptRuntime {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly llm: JavaScriptRuntimeOptions["llm"];
  private readonly executionTimeoutMs: number;
  private readonly pending = new Map<number, PendingExecution>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private executionQueue: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private stderr = "";
  private closed = false;

  constructor(options: JavaScriptRuntimeOptions) {
    this.executionTimeoutMs = positiveInteger(
      options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      "executionTimeoutMs",
    );
    const maxOutputChars = positiveInteger(
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      "maxOutputChars",
    );
    this.llm = options.llm;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);

    const workerUrl = new URL("./runtime-worker.mjs", import.meta.url);
    this.child = spawn("node", [fileURLToPath(workerUrl)], {
      env: process.env.PATH ? { PATH: process.env.PATH } : {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.installProcessHandlers();
    this.send({ type: "init", context: options.context, maxOutputChars });
  }

  execute(code: string, signal?: AbortSignal): Promise<JavaScriptExecutionResult> {
    if (typeof code !== "string") return Promise.reject(new TypeError("code must be a string"));
    const run = this.executionQueue.then(() => this.executeOnce(code, signal));
    this.executionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGKILL");
    const error = new Error("JavaScript runtime was disposed");
    this.rejectReady(error);
    this.failAll(error);
  }

  private async executeOnce(
    code: string,
    signal?: AbortSignal,
  ): Promise<JavaScriptExecutionResult> {
    if (this.closed) throw new Error("JavaScript runtime is closed");
    if (signal?.aborted) throw abortError();
    await this.ready;

    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);
        callback();
      };
      const terminate = (error: Error) => {
        settle(() => reject(error));
        this.dispose();
      };
      const onAbort = () => terminate(abortError());
      const timeout = setTimeout(
        () =>
          terminate(
            new Error(`JavaScript execution exceeded ${this.executionTimeoutMs}ms timeout`),
          ),
        this.executionTimeoutMs,
      );

      this.pending.set(requestId, {
        resolve: (result) => settle(() => resolve(result)),
        reject: (error) => settle(() => reject(error)),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send({ type: "execute", requestId, code });
    });
  }

  private installProcessHandlers(): void {
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.disposeWithError(new Error("JavaScript runtime emitted invalid protocol output"));
        return;
      }

      if (message.type === "ready") {
        this.resolveReady();
        return;
      }
      if (message.type === "executionResult") {
        this.pending.get(message.requestId)?.resolve({
          output: String(message.output),
          error: message.error,
        });
        return;
      }
      if (message.type === "llm") {
        void this.handleLlm(message);
        return;
      }
      if (message.type === "fatal") {
        this.disposeWithError(new Error(`JavaScript runtime failed: ${String(message.error)}`));
      }
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_000);
    });
    this.child.once("error", (error) => this.disposeWithError(error));
    this.child.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.disposeWithError(
        new Error(
          `JavaScript runtime exited unexpectedly (${signal ?? `code ${String(code)}`})${suffix}`,
        ),
      );
    });
  }

  private async handleLlm(message: any): Promise<void> {
    try {
      const result = await this.llm(
        String(message.prompt),
        message.context === undefined ? undefined : String(message.context),
      );
      this.send({ type: "llmResult", callId: message.callId, result });
    } catch (error) {
      this.send({
        type: "llmResult",
        callId: message.callId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }

  private send(message: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private disposeWithError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGKILL");
    this.rejectReady(error);
    this.failAll(error);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function abortError(): DOMException {
  return new DOMException("JavaScript execution aborted", "AbortError");
}
