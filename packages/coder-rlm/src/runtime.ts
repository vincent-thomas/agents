import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { RLMChildHandle, RLMChildResult } from "./child-types.ts";

export interface JavaScriptExecutionResult {
  output: string;
  error?: { name: string; message: string };
}

export interface JavaScriptRuntimeRLM {
  spawn: (
    prompt: string,
    options?: { name?: string; context?: string },
    signal?: AbortSignal,
  ) => Promise<RLMChildHandle>;
  waitAll: (handles: RLMChildHandle[], signal?: AbortSignal) => Promise<RLMChildResult[]>;
  result: (handle: RLMChildHandle, signal?: AbortSignal) => Promise<RLMChildResult>;
  cancel: (handle: RLMChildHandle, signal?: AbortSignal) => Promise<RLMChildResult>;
}

export interface JavaScriptRuntimeOptions {
  context: string;
  rlm: JavaScriptRuntimeRLM;
  javascriptStallTimeoutMs?: number;
  maxOutputChars?: number;
  /** The owning run signal; admitted children are intentionally not tied to worker disposal. */
  signal?: AbortSignal;
  /** Heartbeat period sent by the worker while an execution awaits waitAll. */
  heartbeatIntervalMs?: number;
}

interface PendingExecution {
  resolve: (result: JavaScriptExecutionResult) => void;
  reject: (error: Error) => void;
}

interface ActiveExecution {
  requestId: number;
  abortController: AbortController;
  watchdog: ReturnType<typeof setTimeout> | undefined;
  onTimeout: () => void;
}

interface WorkerHeartbeatMessage {
  type: "heartbeat";
  requestId?: number;
  operation?: string;
  pendingRlmCalls: number;
}

const DEFAULT_JAVASCRIPT_STALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

export class JavaScriptRuntime {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rlm: JavaScriptRuntimeRLM;
  private readonly ownerSignal: AbortSignal | undefined;
  private readonly javascriptStallTimeoutMs: number;
  private readonly pending = new Map<number, PendingExecution>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private executionQueue: Promise<void> = Promise.resolve();
  private nextRequestId = 1;
  private activeExecution: ActiveExecution | undefined;
  private stderr = "";
  private closed = false;

  constructor(options: JavaScriptRuntimeOptions) {
    this.javascriptStallTimeoutMs = positiveInteger(
      options.javascriptStallTimeoutMs ?? DEFAULT_JAVASCRIPT_STALL_TIMEOUT_MS,
      "javascriptStallTimeoutMs",
    );
    const maxOutputChars = positiveInteger(
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      "maxOutputChars",
    );
    const heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ??
        Math.max(1, Math.min(250, Math.floor(this.javascriptStallTimeoutMs / 3))),
      "heartbeatIntervalMs",
    );
    this.rlm = options.rlm;
    this.ownerSignal = options.signal;
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
    this.send({
      type: "init",
      context: options.context,
      rootDirectory: process.cwd(),
      maxOutputChars,
      heartbeatIntervalMs,
    });
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
    this.activeExecution?.abortController.abort();
    this.activeExecution = undefined;
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
    if (signal?.aborted || this.ownerSignal?.aborted) throw abortError();
    await this.ready;

    const requestId = this.nextRequestId++;
    const abortController = new AbortController();
    const execution: ActiveExecution = {
      requestId,
      abortController,
      watchdog: undefined,
      onTimeout: () => undefined,
    };
    this.activeExecution = execution;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (execution.watchdog !== undefined) clearTimeout(execution.watchdog);
        execution.watchdog = undefined;
        signal?.removeEventListener("abort", onAbort);
        this.ownerSignal?.removeEventListener("abort", onOwnerAbort);
        this.pending.delete(requestId);
        if (this.activeExecution?.requestId === requestId) this.activeExecution = undefined;
        callback();
      };
      const terminate = (error: Error) => {
        settle(() => reject(error));
        this.dispose();
        abortController.abort();
      };
      const onAbort = () => terminate(abortError());
      const onOwnerAbort = () => terminate(abortError());
      execution.onTimeout = () =>
        terminate(
          new Error(
            `JavaScript execution exceeded ${this.javascriptStallTimeoutMs}ms stall timeout`,
          ),
        );
      this.rearmWatchdog(execution);

      this.pending.set(requestId, {
        resolve: (result) => settle(() => resolve(result)),
        reject: (error) => settle(() => reject(error)),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.ownerSignal?.addEventListener("abort", onOwnerAbort, { once: true });
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
      if (message.type === "heartbeat") {
        this.handleHeartbeat(message);
        return;
      }
      if (message.type === "rlm") {
        void this.handleRlm(message).catch((error) => {
          this.disposeWithError(asError(error));
        });
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

  private handleHeartbeat(message: WorkerHeartbeatMessage): void {
    if (
      !Number.isSafeInteger(message.requestId) ||
      message.requestId < 1 ||
      message.operation !== "waitAll" ||
      !Number.isSafeInteger(message.pendingRlmCalls) ||
      message.pendingRlmCalls < 1
    ) {
      return;
    }
    const activeExecution = this.activeExecution;
    if (activeExecution?.requestId === message.requestId) this.rearmWatchdog(activeExecution);
  }

  private rearmWatchdog(execution: ActiveExecution): void {
    if (this.activeExecution?.requestId !== execution.requestId || this.closed) return;
    if (execution.watchdog !== undefined) clearTimeout(execution.watchdog);
    execution.watchdog = setTimeout(execution.onTimeout, this.javascriptStallTimeoutMs);
  }

  private async handleRlm(message: any): Promise<void> {
    try {
      const signal = this.activeExecution?.abortController.signal;
      let result: unknown;
      switch (message.op) {
        case "spawn":
          result = await this.rlm.spawn(
            String(message.prompt),
            message.options === undefined
              ? undefined
              : {
                  name:
                    message.options.name === undefined ? undefined : String(message.options.name),
                  context:
                    message.options.context === undefined
                      ? undefined
                      : String(message.options.context),
                },
            signal,
          );
          break;
        case "waitAll":
          result = await this.rlm.waitAll(message.handles, signal);
          break;
        case "result":
          result = await this.rlm.result(message.handle, signal);
          break;
        case "cancel":
          result = await this.rlm.cancel(message.handle, signal);
          break;
        default:
          throw new Error(`Unknown RLM operation: ${String(message.op)}`);
      }
      this.send({ type: "rlmResult", callId: message.callId, result });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.send({
        type: "rlmResult",
        callId: message.callId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }

  private send(message: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.disposeWithError(asError(error));
    }
  }

  private disposeWithError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.activeExecution?.abortController.abort();
    this.activeExecution = undefined;
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(): DOMException {
  return new DOMException("JavaScript execution aborted", "AbortError");
}
