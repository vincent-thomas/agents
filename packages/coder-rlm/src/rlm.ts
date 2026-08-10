import {
  Agent,
  type AgentEvent,
  type AgentOptions,
  type AgentState,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type StopReason,
  type Usage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createJavascriptTool } from "./javascript-tool.ts";
import { buildLeafPrompt, RLM_SYSTEM_PROMPT } from "./prompt.ts";
import {
  JavaScriptRuntime,
  type JavaScriptRuntimeOptions,
  type JavaScriptRuntimeRLM,
} from "./runtime.ts";
import type {
  RLMChildHandle,
  RLMChildResult,
  RLMChildStatus,
  RLMChildTier,
} from "./child-types.ts";
export type {
  RLMChildHandle,
  RLMChildResult,
  RLMChildStatus,
  RLMChildTier,
} from "./child-types.ts";

export interface RLMChildTierProfile {
  model?: Model<any>;
  thinkingLevel?: AgentState["thinkingLevel"];
  modelRequestTimeoutMs?: number;
}

export interface RLMOptions {
  model: Model<any>;
  context: string;
  thinkingLevel?: AgentState["thinkingLevel"];
  /** Host-side overrides for the provider-agnostic fast/balanced/deep defaults. */
  tierProfiles?: Partial<Record<RLMChildTier, RLMChildTierProfile>>;
  getApiKey?: AgentOptions["getApiKey"];
  onEvent?: (event: RLMEvent) => Promise<void> | void;
  maxDepth?: number;
  maxModelCalls?: number;
  maxDeepChildren?: number;
  javascriptStallTimeoutMs?: number;
  modelRequestTimeoutMs?: number;
  runTimeoutMs?: number;
  maxOutputChars?: number;
}

export interface RLMRunOptions {
  signal?: AbortSignal;
}

export interface RLMResult {
  text: string;
  usage: RLMUsage;
}

export interface RLMUsage {
  modelCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface RLMEventBase {
  runId: number;
  parentRunId?: number;
  depth: number;
}

export type RLMEvent = RLMEventBase &
  (
    | {
        type: "run_start";
        prompt: string;
        contextLength: number;
        isLeaf: boolean;
      }
    | { type: "model_start"; modelCall: number }
    | {
        type: "model_end";
        modelCall: number;
        stopReason: StopReason;
        usage: Usage;
      }
    | { type: "javascript_start"; toolCallId: string; code: string }
    | {
        type: "javascript_end";
        toolCallId: string;
        output: string;
        isError: boolean;
      }
    | { type: "run_end"; result: string; usage: RLMUsage }
    | { type: "run_error"; error: string; usage: RLMUsage }
    | {
        type: "child_spawn";
        handle: RLMChildHandle;
        tier: RLMChildTier;
        prompt: string;
        contextLength: number;
      }
    | { type: "child_start"; handle: RLMChildHandle }
    | { type: "child_end"; result: RLMChildResult }
    | { type: "child_error"; result: RLMChildResult }
    | { type: "child_cancel"; result: RLMChildResult }
  );

const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_RUN_TIMEOUT_MS = 1_800_000;

export interface RLMDependencies {
  streamFn?: StreamFn;
  createRuntime?: (options: JavaScriptRuntimeOptions) => JavaScriptRuntime;
}

interface ResolvedTierProfile {
  model: Model<any>;
  thinkingLevel: AgentState["thinkingLevel"];
  modelRequestTimeoutMs: number;
}

type ResolvedTierProfiles = Record<RLMChildTier, ResolvedTierProfile>;

interface ResolvedOptions {
  model: Model<any>;
  context: string;
  thinkingLevel: AgentState["thinkingLevel"];
  tierProfiles: ResolvedTierProfiles;
  getApiKey: AgentOptions["getApiKey"];
  onEvent: RLMOptions["onEvent"];
  maxDepth: number;
  maxModelCalls: number;
  maxDeepChildren: number;
  javascriptStallTimeoutMs: number | undefined;
  modelRequestTimeoutMs: number;
  runTimeoutMs: number | undefined;
  maxOutputChars: number | undefined;
}

interface RunState {
  budget: ModelCallBudget;
  usage: UsageAccumulator;
  nextRunId: number;
  topAbort: AbortController;
  timedOut: boolean;
  registry: ChildRegistry;
  events: EventQueue;
}

/** Serializes observer delivery without making admission or execution wait for it. */
class EventQueue {
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | undefined;

  constructor(
    private readonly observer: RLMOptions["onEvent"],
    private readonly onFailure: (error: Error) => void,
  ) {}

  enqueue(event: RLMEvent): Promise<void> {
    const delivery = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      await this.observer?.(event);
    });
    this.tail = delivery.catch((error) => {
      this.fail(error);
    });
    return delivery;
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure;
  }

  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = asError(error);
    this.onFailure(this.failure);
  }
}

class ModelCallBudget {
  used = 0;
  private exhaustedError: Error | undefined;
  private readonly exhaustionListeners = new Set<() => void>();

  constructor(readonly maximum: number) {}

  acquire(): boolean {
    if (this.used >= this.maximum) {
      if (!this.exhaustedError) {
        this.exhaustedError = new Error(`RLM exceeded its ${this.maximum} model-call limit`);
        for (const listener of this.exhaustionListeners) listener();
      }
      return false;
    }
    this.used += 1;
    return true;
  }

  get error(): Error | undefined {
    return this.exhaustedError;
  }

  onExhausted(listener: () => void): () => void {
    if (this.exhaustedError) listener();
    else this.exhaustionListeners.add(listener);
    return () => this.exhaustionListeners.delete(listener);
  }
}

class UsageAccumulator {
  private readonly aggregate: RLMUsage = emptyUsage();

  startModelCall(): number {
    this.aggregate.modelCalls += 1;
    return this.aggregate.modelCalls;
  }

  add(usage: Usage): void {
    this.aggregate.input += usage.input;
    this.aggregate.output += usage.output;
    this.aggregate.cacheRead += usage.cacheRead;
    this.aggregate.cacheWrite += usage.cacheWrite;
    this.aggregate.cacheWrite1h += usage.cacheWrite1h ?? 0;
    this.aggregate.reasoning += usage.reasoning ?? 0;
    this.aggregate.totalTokens += usage.totalTokens;
    this.aggregate.cost.input += usage.cost.input;
    this.aggregate.cost.output += usage.cost.output;
    this.aggregate.cost.cacheRead += usage.cost.cacheRead;
    this.aggregate.cost.cacheWrite += usage.cost.cacheWrite;
    this.aggregate.cost.total += usage.cost.total;
  }

  snapshot(): RLMUsage {
    return structuredClone(this.aggregate);
  }
}

interface ChildParent {
  runId: number;
  depth: number;
  signal: AbortSignal;
}

interface ChildRecord {
  handle: RLMChildHandle;
  runId: number;
  controller: AbortController;
  status: RLMChildStatus;
  result: RLMChildResult;
  /** Public completion may resolve on cancellation before launch cleanup finishes. */
  promise: Promise<RLMChildResult>;
  resolveResult: (result: RLMChildResult) => void;
  /** Underlying launch task, awaited by top-level cleanup. */
  launchTask: Promise<void>;
  settled: boolean;
}

class ChildRegistry {
  private nextId = 1;
  private deepChildrenAdmitted = 0;
  private readonly records = new Map<number, ChildRecord>();

  constructor(
    private readonly maxDepth: number,
    private readonly maxDeepChildren: number,
    private readonly emit: (event: RLMEvent) => Promise<void>,
    private readonly reserveRunId: () => number,
    private readonly runChild: (
      prompt: string,
      context: string,
      tier: RLMChildTier,
      depth: number,
      parentRunId: number,
      runId: number,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {}

  spawn(
    parent: ChildParent,
    prompt: string,
    options: { name?: string; context?: string; tier?: RLMChildTier },
  ): RLMChildHandle {
    throwIfAborted(parent.signal);
    const tier = validateTier(options.tier ?? "balanced");
    if (parent.depth >= this.maxDepth) {
      throw new Error(`RLM maximum depth ${this.maxDepth} reached`);
    }
    if (tier === "deep" && this.deepChildrenAdmitted >= this.maxDeepChildren) {
      throw new Error(`RLM maximum deep children ${this.maxDeepChildren} reached`);
    }
    // JavaScript admission is synchronous: reserve this before publishing the handle.
    if (tier === "deep") this.deepChildrenAdmitted += 1;
    const id = this.nextId++;
    const handle: RLMChildHandle = {
      id,
      name: options.name ?? `child-${id}`,
      parentRunId: parent.runId,
      depth: parent.depth + 1,
      tier,
    };
    const controller = new AbortController();
    const unlink = linkAbort(parent.signal, controller);
    let resolveResult!: (result: RLMChildResult) => void;
    const record: ChildRecord = {
      handle,
      runId: this.reserveRunId(),
      controller,
      status: "pending",
      result: { handle, tier, status: "pending" },
      promise: new Promise<RLMChildResult>((resolve) => {
        resolveResult = resolve;
      }),
      resolveResult,
      launchTask: Promise.resolve(),
      settled: false,
    };
    this.records.set(id, record);
    void this.emit({
      type: "child_spawn",
      runId: parent.runId,
      parentRunId: parent.runId,
      depth: parent.depth,
      handle,
      tier,
      prompt,
      contextLength: (options.context ?? "").length,
    }).catch(() => undefined);
    record.launchTask = this.launch(record, prompt, options.context ?? "", unlink);
    return handle;
  }

  async waitAll(
    ownerRunId: number,
    handles: RLMChildHandle[],
    signal?: AbortSignal,
  ): Promise<RLMChildResult[]> {
    if (!Array.isArray(handles)) throw new TypeError("ctx.rlm.waitAll() expects an array");
    throwIfAborted(signal);
    const completion = Promise.all(handles.map((handle) => this.get(ownerRunId, handle).promise));
    if (!signal) return completion;
    return new Promise<RLMChildResult[]>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      completion.then(
        (results) => finish(() => resolve(results)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  result(ownerRunId: number, handle: RLMChildHandle): RLMChildResult {
    return structuredClone(this.get(ownerRunId, handle).result);
  }

  async cancel(ownerRunId: number, handle: RLMChildHandle): Promise<RLMChildResult> {
    const record = this.get(ownerRunId, handle);
    this.markCancelled(record);
    await record.launchTask;
    return record.promise;
  }

  cancelAll(): void {
    for (const record of this.records.values()) this.markCancelled(record);
  }

  async waitForLaunches(): Promise<void> {
    for (;;) {
      const records = [...this.records.values()];
      await Promise.all(records.map((record) => record.launchTask));
      if (records.length === this.records.size) return;
    }
  }

  private markCancelled(record: ChildRecord): void {
    if (record.settled || (record.status !== "pending" && record.status !== "running")) return;
    record.controller.abort();
    this.finish(
      record,
      {
        ...record.result,
        status: "cancelled",
        error: { name: "AbortError", message: "RLM child cancelled" },
      },
      "child_cancel",
    );
  }

  private finish(
    record: ChildRecord,
    result: RLMChildResult,
    eventType: "child_end" | "child_error" | "child_cancel",
  ): void {
    if (record.settled) return;
    record.settled = true;
    record.status = result.status;
    record.result = result;
    record.resolveResult(structuredClone(result));
    void this.emit({
      type: eventType,
      runId: record.runId,
      parentRunId: record.handle.parentRunId,
      depth: record.handle.depth,
      result,
    }).catch(() => undefined);
  }

  private get(ownerRunId: number, handle: RLMChildHandle): ChildRecord {
    if (!handle || !Number.isSafeInteger(handle.id))
      throw new TypeError("invalid RLM child handle");
    const record = this.records.get(handle.id);
    if (record && record.handle.parentRunId !== ownerRunId) {
      throw new Error(`RLM child handle ${String(handle.id)} does not belong to this run`);
    }
    if (
      !record ||
      record.handle.name !== handle.name ||
      record.handle.parentRunId !== handle.parentRunId ||
      record.handle.depth !== handle.depth ||
      record.handle.tier !== handle.tier
    ) {
      throw new Error(`unknown RLM child handle ${String(handle.id)}`);
    }
    return record;
  }

  private async launch(
    record: ChildRecord,
    prompt: string,
    context: string,
    unlink: () => void,
  ): Promise<void> {
    try {
      if (record.settled) return;
      record.status = "running";
      record.result = { ...record.result, status: "running" };
      void this.emit({
        type: "child_start",
        runId: record.runId,
        parentRunId: record.handle.parentRunId,
        depth: record.handle.depth,
        handle: record.handle,
      }).catch(() => undefined);
      if (record.settled) return;
      const text = await this.runChild(
        prompt,
        context,
        record.handle.tier,
        record.handle.depth,
        record.handle.parentRunId,
        record.runId,
        record.controller.signal,
      );
      if (!record.settled) {
        this.finish(record, { ...record.result, status: "succeeded", text }, "child_end");
      }
    } catch (error) {
      if (!record.settled) {
        const cancelled = record.controller.signal.aborted;
        this.finish(
          record,
          {
            ...record.result,
            status: cancelled ? "cancelled" : "failed",
            error: {
              name: cancelled ? "AbortError" : asError(error).name,
              message: cancelled ? "RLM child cancelled" : errorMessage(error),
            },
          },
          cancelled ? "child_cancel" : "child_error",
        );
      }
    } finally {
      unlink();
    }
  }
}

export class RLM {
  private readonly options: ResolvedOptions;
  private readonly streamFn: StreamFn;
  private readonly createRuntime: NonNullable<RLMDependencies["createRuntime"]>;

  constructor(options: RLMOptions, dependencies: RLMDependencies = {}) {
    if (typeof options.context !== "string") throw new TypeError("context must be a string");
    const thinkingLevel = options.thinkingLevel ?? "high";
    const modelRequestTimeoutMs = positiveInteger(
      options.modelRequestTimeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
      "modelRequestTimeoutMs",
    );
    this.options = {
      model: options.model,
      context: options.context,
      thinkingLevel,
      tierProfiles: resolveTierProfiles(options.model, modelRequestTimeoutMs, options.tierProfiles),
      getApiKey: options.getApiKey,
      onEvent: options.onEvent,
      maxDepth: positiveInteger(options.maxDepth ?? 3, "maxDepth"),
      maxModelCalls: positiveInteger(options.maxModelCalls ?? 32, "maxModelCalls"),
      maxDeepChildren: nonNegativeInteger(options.maxDeepChildren ?? 4, "maxDeepChildren"),
      javascriptStallTimeoutMs: optionalPositiveInteger(
        options.javascriptStallTimeoutMs,
        "javascriptStallTimeoutMs",
      ),
      modelRequestTimeoutMs,
      runTimeoutMs: positiveInteger(options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, "runTimeoutMs"),
      maxOutputChars: optionalPositiveInteger(options.maxOutputChars, "maxOutputChars"),
    };
    this.streamFn = dependencies.streamFn ?? streamSimple;
    this.createRuntime =
      dependencies.createRuntime ?? ((runtimeOptions) => new JavaScriptRuntime(runtimeOptions));
  }

  async run(prompt: string, options: RLMRunOptions = {}): Promise<string> {
    return (await this.runDetailed(prompt, options)).text;
  }

  async runDetailed(prompt: string, options: RLMRunOptions = {}): Promise<RLMResult> {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new TypeError("prompt must be a non-empty string");
    }
    throwIfAborted(options.signal);
    const topAbort = new AbortController();
    let registry!: ChildRegistry;
    const events = new EventQueue(this.options.onEvent, (error) => {
      topAbort.abort(error);
    });
    const state: RunState = {
      budget: new ModelCallBudget(this.options.maxModelCalls),
      usage: new UsageAccumulator(),
      nextRunId: 0,
      topAbort,
      timedOut: false,
      registry,
      events,
    };
    const unlink = options.signal ? linkAbort(options.signal, topAbort) : () => undefined;
    state.registry = new ChildRegistry(
      this.options.maxDepth,
      this.options.maxDeepChildren,
      (event) => state.events.enqueue(event),
      () => state.nextRunId++,
      (childPrompt, childContext, tier, depth, parentRunId, runId, signal) =>
        this.runAtDepth(childPrompt, childContext, tier, depth, parentRunId, state, signal, runId),
    );
    const timeout =
      this.options.runTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            state.timedOut = true;
            topAbort.abort();
            void state.registry.cancelAll();
          }, this.options.runTimeoutMs);
    let result: RLMResult | undefined;
    let failure: unknown;
    try {
      const text = await this.runAtDepth(
        prompt,
        this.options.context,
        undefined,
        0,
        undefined,
        state,
        topAbort.signal,
      );
      result = { text, usage: state.usage.snapshot() };
    } catch (error) {
      failure = error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      topAbort.abort();
      state.registry.cancelAll();
      await state.registry.waitForLaunches();
      unlink();
    }
    await events.flush();
    if (failure !== undefined) throw failure;
    if (!result) throw new Error("RLM completed without a result");
    return result;
  }

  private async runAtDepth(
    prompt: string,
    context: string,
    tier: RLMChildTier | undefined,
    depth: number,
    parentRunId: number | undefined,
    state: RunState,
    signal?: AbortSignal,
    reservedRunId?: number,
  ): Promise<string> {
    throwIfAborted(signal);
    const runId = reservedRunId ?? state.nextRunId++;
    const trace = { runId, parentRunId, depth };
    const isLeaf = depth >= this.options.maxDepth;
    const tierProfile = tier === undefined ? undefined : this.options.tierProfiles[tier];
    const requestTimeoutMs =
      tierProfile?.modelRequestTimeoutMs ?? this.options.modelRequestTimeoutMs;
    // Trace delivery must not prevent an admitted sibling from reaching its model turn.
    // In particular, observers may perform their own asynchronous coordination here.
    void state.events
      .enqueue({
        ...trace,
        type: "run_start",
        prompt,
        contextLength: context.length,
        isLeaf,
      })
      .catch(() => undefined);

    let runtime: JavaScriptRuntime | undefined;
    if (!isLeaf) {
      const rlm: JavaScriptRuntimeRLM = {
        spawn: async (childPrompt, childOptions, operationSignal) => {
          throwIfAborted(operationSignal);
          return state.registry.spawn(
            { runId, depth, signal: signal ?? state.topAbort.signal },
            childPrompt,
            { ...childOptions, context: childOptions?.context ?? context },
          );
        },
        waitAll: (handles, childSignal) => state.registry.waitAll(runId, handles, childSignal),
        result: async (handle) => state.registry.result(runId, handle),
        cancel: (handle) => state.registry.cancel(runId, handle),
      };
      runtime = this.createRuntime({
        context,
        javascriptStallTimeoutMs: this.options.javascriptStallTimeoutMs,
        maxOutputChars: this.options.maxOutputChars,
        signal,
        rlm,
      });
    }

    let stoppedForBudget = false;
    let activeModelCall = 0;
    let modelCallInFlight = false;
    let fatalRuntimeError: Error | undefined;
    let modelRequestTimedOut = false;
    let abortAgent: (() => void) | undefined;
    let cleanupModelRequest: (() => void) | undefined;
    let rejectModelRequestTimeout: ((error: Error) => void) | undefined;
    const modelTimeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectModelRequestTimeout = reject;
    });
    let rejectAbort: ((error: DOMException) => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    let removeAbortListener: (() => void) | undefined;
    let modelCallReserved = false;
    const requestStreamFn: StreamFn = (model, modelContext, streamOptions) => {
      const parentSignal = streamOptions?.signal;
      const unavailable =
        signal?.aborted || parentSignal?.aborted || state.budget.error || !modelCallReserved;
      modelCallReserved = false;
      if (unavailable) {
        stoppedForBudget ||= state.budget.error !== undefined;
        const error = state.budget.error ?? abortError();
        return assistantFailureStream(model, error, state.budget.error ? "error" : "aborted");
      }

      activeModelCall = state.usage.startModelCall();
      modelCallInFlight = true;
      void state.events
        .enqueue({ ...trace, type: "model_start", modelCall: activeModelCall })
        .catch(() => undefined);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      parentSignal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        modelRequestTimedOut = true;
        controller.abort();
        rejectModelRequestTimeout?.(
          new Error(`RLM model request exceeded ${requestTimeoutMs}ms timeout`),
        );
        abortAgent?.();
      }, requestTimeoutMs);
      cleanupModelRequest = () => {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onAbort);
        if (cleanupModelRequest) cleanupModelRequest = undefined;
      };

      try {
        return Promise.resolve(
          this.streamFn(model, modelContext, {
            ...streamOptions,
            signal: controller.signal,
          }),
        ).catch((error) => assistantFailureStream(model, asError(error), "error"));
      } catch (error) {
        return assistantFailureStream(model, asError(error), "error");
      }
    };
    const onFatalRuntimeError = (error: unknown) => {
      if (fatalRuntimeError) return;
      fatalRuntimeError = asError(error);
      abortAgent?.();
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: isLeaf
          ? "Answer the task using the delegated external context supplied by the user."
          : RLM_SYSTEM_PROMPT,
        model: tierProfile?.model ?? this.options.model,
        thinkingLevel: tierProfile?.thinkingLevel ?? this.options.thinkingLevel,
        tools: runtime
          ? [createJavascriptTool(runtime, { onFatalError: onFatalRuntimeError })]
          : [],
      },
      streamFn: requestStreamFn,
      getApiKey: this.options.getApiKey,
      shouldStopAfterTurn: ({ toolResults }) => {
        if (fatalRuntimeError) return true;
        if (toolResults.length === 0) return false;
        if (state.budget.acquire()) {
          modelCallReserved = true;
          return false;
        }
        stoppedForBudget = true;
        return true;
      },
    });
    abortAgent = () => agent.abort();
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === "turn_start") return;
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (!modelCallInFlight) return;
        modelCallInFlight = false;
        cleanupModelRequest?.();
        state.usage.add(event.message.usage);
        void state.events
          .enqueue({
            ...trace,
            type: "model_end",
            modelCall: activeModelCall,
            stopReason: event.message.stopReason,
            usage: structuredClone(event.message.usage),
          })
          .catch(() => undefined);
        return;
      }
      this.emitToolEvent(state.events, trace, event);
    });
    const unsubscribeBudget = state.budget.onExhausted(() => agent.abort());
    const onAbort = () => agent.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal) {
      const onSignalAbort = () => {
        abortAgent?.();
        rejectAbort?.(abortError());
      };
      signal.addEventListener("abort", onSignalAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onSignalAbort);
    }

    try {
      throwIfAborted(signal);
      if (!state.budget.acquire())
        throw (
          state.budget.error ??
          new Error(`RLM exceeded its ${state.budget.maximum} model-call limit`)
        );
      modelCallReserved = true;
      const promptPromise = agent.prompt(isLeaf ? buildLeafPrompt(prompt, context) : prompt);
      const waits: Promise<unknown>[] = [promptPromise];
      waits.push(modelTimeoutPromise);
      if (signal) waits.push(abortPromise);
      await Promise.race(waits);
      throwIfAborted(signal);
      if (state.budget.error) throw state.budget.error;
      if (fatalRuntimeError) throw fatalRuntimeError;
      if (stoppedForBudget) {
        throw new Error(
          `RLM exceeded its ${state.budget.maximum} model-call limit before synthesis`,
        );
      }
      const result = finalResponse(agent.state.messages);
      void state.events
        .enqueue({ ...trace, type: "run_end", result, usage: state.usage.snapshot() })
        .catch(() => undefined);
      return result;
    } catch (error) {
      const failure = state.timedOut
        ? new Error(`RLM run exceeded ${this.options.runTimeoutMs}ms overall timeout`)
        : signal?.aborted
          ? abortError()
          : modelRequestTimedOut
            ? new Error(`RLM model request exceeded ${requestTimeoutMs}ms timeout`)
            : (fatalRuntimeError ??
              (stoppedForBudget && state.budget.error
                ? new Error(`${state.budget.error.message} before synthesis`)
                : (state.budget.error ?? error)));
      void state.events
        .enqueue({
          ...trace,
          type: "run_error",
          error: errorMessage(failure),
          usage: state.usage.snapshot(),
        })
        .catch(() => undefined);
      throw failure;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      removeAbortListener?.();
      cleanupModelRequest?.();
      unsubscribeBudget();
      unsubscribe();
      runtime?.dispose();
    }
  }

  private emitToolEvent(events: EventQueue, trace: RLMEventBase, event: AgentEvent): void {
    if (event.type === "tool_execution_start" && event.toolName === "javascript") {
      void events
        .enqueue({
          ...trace,
          type: "javascript_start",
          toolCallId: event.toolCallId,
          code: typeof event.args?.code === "string" ? event.args.code : "",
        })
        .catch(() => undefined);
    } else if (event.type === "tool_execution_end" && event.toolName === "javascript") {
      void events
        .enqueue({
          ...trace,
          type: "javascript_end",
          toolCallId: event.toolCallId,
          output: toolResultText(event.result),
          isError: event.isError,
        })
        .catch(() => undefined);
    }
  }
}

function assistantFailureStream(model: Model<any>, error: Error, stopReason: "error" | "aborted") {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: error.message,
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: stopReason, error: message });
  stream.end(message);
  return stream;
}

function emptyUsage(): RLMUsage {
  return {
    modelCalls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toolResultText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    return String(result);
  }
  const content = result.content;
  if (!Array.isArray(content)) return String(result);
  return content
    .filter(
      (item): item is { type?: unknown; text?: unknown } =>
        typeof item === "object" && item !== null,
    )
    .filter((item) => item.type === "text")
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finalResponse(messages: readonly unknown[]): string {
  const response = messages.findLast(isAssistantMessage);
  if (!response) throw new Error("RLM completed without an assistant response");
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `RLM model stopped with ${response.stopReason}`);
  }
  const text = contentText(response.content).trim();
  if (!text) throw new Error("RLM completed without a textual answer");
  return text;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant"
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  const onAbort = () => child.abort();
  if (parent.aborted) child.abort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

function abortError(): DOMException {
  return new DOMException("RLM run aborted", "AbortError");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function validateTier(value: unknown): RLMChildTier {
  if (value !== "fast" && value !== "balanced" && value !== "deep") {
    throw new TypeError("ctx.rlm.spawn() tier must be fast, balanced, or deep");
  }
  return value;
}

function resolveTierProfiles(
  rootModel: Model<any>,
  rootTimeout: number,
  overrides: RLMOptions["tierProfiles"],
): ResolvedTierProfiles {
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null)) {
    throw new TypeError("tierProfiles must be an object when provided");
  }
  const defaults: ResolvedTierProfiles = {
    fast: { model: rootModel, thinkingLevel: "low", modelRequestTimeoutMs: rootTimeout },
    balanced: { model: rootModel, thinkingLevel: "medium", modelRequestTimeoutMs: rootTimeout },
    deep: { model: rootModel, thinkingLevel: "high", modelRequestTimeoutMs: rootTimeout },
  };
  for (const key of Object.keys(overrides ?? {})) {
    if (key !== "fast" && key !== "balanced" && key !== "deep") {
      throw new TypeError(`tierProfiles contains unknown tier ${key}`);
    }
  }
  for (const tier of ["fast", "balanced", "deep"] as const) {
    const override = overrides?.[tier];
    if (override !== undefined && (typeof override !== "object" || override === null)) {
      throw new TypeError(`tierProfiles.${tier} must be an object when provided`);
    }
    if (override?.modelRequestTimeoutMs !== undefined) {
      positiveInteger(override.modelRequestTimeoutMs, `tierProfiles.${tier}.modelRequestTimeoutMs`);
    }
    defaults[tier] = {
      model: override?.model ?? defaults[tier].model,
      thinkingLevel: override?.thinkingLevel ?? defaults[tier].thinkingLevel,
      modelRequestTimeoutMs:
        override?.modelRequestTimeoutMs ?? defaults[tier].modelRequestTimeoutMs,
    };
  }
  return defaults;
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name);
}
