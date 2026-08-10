import {
  Agent,
  type AgentEvent,
  type AgentOptions,
  type AgentState,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  type AssistantMessage,
  type Model,
  type StopReason,
  type Usage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createJavascriptTool } from "./javascript-tool.ts";
import { buildLeafPrompt, RLM_SYSTEM_PROMPT } from "./prompt.ts";
import { JavaScriptRuntime, type JavaScriptRuntimeOptions } from "./runtime.ts";

export interface RLMOptions {
  model: Model<any>;
  context: string;
  thinkingLevel?: AgentState["thinkingLevel"];
  getApiKey?: AgentOptions["getApiKey"];
  onEvent?: (event: RLMEvent) => Promise<void> | void;
  maxDepth?: number;
  maxModelCalls?: number;
  executionTimeoutMs?: number;
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
  );

export interface RLMDependencies {
  streamFn?: StreamFn;
  createRuntime?: (options: JavaScriptRuntimeOptions) => JavaScriptRuntime;
}

interface ResolvedOptions {
  model: Model<any>;
  context: string;
  thinkingLevel: AgentState["thinkingLevel"];
  getApiKey: AgentOptions["getApiKey"];
  onEvent: RLMOptions["onEvent"];
  maxDepth: number;
  maxModelCalls: number;
  executionTimeoutMs: number | undefined;
  maxOutputChars: number | undefined;
}

interface RunState {
  budget: ModelCallBudget;
  usage: UsageAccumulator;
  nextRunId: number;
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

export class RLM {
  private readonly options: ResolvedOptions;
  private readonly streamFn: StreamFn;
  private readonly createRuntime: NonNullable<RLMDependencies["createRuntime"]>;

  constructor(options: RLMOptions, dependencies: RLMDependencies = {}) {
    if (typeof options.context !== "string") throw new TypeError("context must be a string");
    this.options = {
      model: options.model,
      context: options.context,
      thinkingLevel: options.thinkingLevel ?? "high",
      getApiKey: options.getApiKey,
      onEvent: options.onEvent,
      maxDepth: positiveInteger(options.maxDepth ?? 3, "maxDepth"),
      maxModelCalls: positiveInteger(options.maxModelCalls ?? 32, "maxModelCalls"),
      executionTimeoutMs: optionalPositiveInteger(options.executionTimeoutMs, "executionTimeoutMs"),
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
    const state: RunState = {
      budget: new ModelCallBudget(this.options.maxModelCalls),
      usage: new UsageAccumulator(),
      nextRunId: 0,
    };
    const text = await this.runAtDepth(
      prompt,
      this.options.context,
      0,
      undefined,
      state,
      options.signal,
    );
    return { text, usage: state.usage.snapshot() };
  }

  private async runAtDepth(
    prompt: string,
    context: string,
    depth: number,
    parentRunId: number | undefined,
    state: RunState,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    if (!state.budget.acquire()) {
      if (state.budget.error) throw state.budget.error;
      throw new Error(`RLM exceeded its ${state.budget.maximum} model-call limit`);
    }

    const runId = state.nextRunId++;
    const trace = { runId, parentRunId, depth };
    const isLeaf = depth >= this.options.maxDepth;
    await this.emit({
      ...trace,
      type: "run_start",
      prompt,
      contextLength: context.length,
      isLeaf,
    });

    let runtime: JavaScriptRuntime | undefined;
    if (!isLeaf) {
      runtime = this.createRuntime({
        context,
        executionTimeoutMs: this.options.executionTimeoutMs,
        maxOutputChars: this.options.maxOutputChars,
        llm: (childPrompt, childContext, childSignal) =>
          this.runAtDepth(
            childPrompt,
            childContext ?? context,
            depth + 1,
            runId,
            state,
            childSignal ?? signal,
          ),
      });
    }

    let stoppedForBudget = false;
    let activeModelCall = 0;
    let fatalRuntimeError: Error | undefined;
    let abortAgent: (() => void) | undefined;
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
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
        tools: runtime
          ? [createJavascriptTool(runtime, { onFatalError: onFatalRuntimeError })]
          : [],
      },
      streamFn: this.streamFn,
      getApiKey: this.options.getApiKey,
      shouldStopAfterTurn: ({ toolResults }) => {
        if (fatalRuntimeError) return true;
        if (toolResults.length === 0) return false;
        if (state.budget.acquire()) return false;
        stoppedForBudget = true;
        return true;
      },
    });
    abortAgent = () => agent.abort();
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === "turn_start") {
        activeModelCall = state.usage.startModelCall();
        await this.emit({ ...trace, type: "model_start", modelCall: activeModelCall });
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        state.usage.add(event.message.usage);
        await this.emit({
          ...trace,
          type: "model_end",
          modelCall: activeModelCall,
          stopReason: event.message.stopReason,
          usage: structuredClone(event.message.usage),
        });
        return;
      }
      await this.emitToolEvent(trace, event);
    });
    const unsubscribeBudget = state.budget.onExhausted(() => agent.abort());
    const onAbort = () => agent.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      throwIfAborted(signal);
      if (state.budget.error) throw state.budget.error;
      await agent.prompt(isLeaf ? buildLeafPrompt(prompt, context) : prompt);
      throwIfAborted(signal);
      if (state.budget.error) throw state.budget.error;
      if (fatalRuntimeError) throw fatalRuntimeError;
      if (stoppedForBudget) {
        throw new Error(
          `RLM exceeded its ${state.budget.maximum} model-call limit before synthesis`,
        );
      }
      const result = finalResponse(agent.state.messages);
      await this.emit({ ...trace, type: "run_end", result, usage: state.usage.snapshot() });
      return result;
    } catch (error) {
      const failure = signal?.aborted
        ? abortError()
        : (fatalRuntimeError ??
          (stoppedForBudget && state.budget.error
            ? new Error(`${state.budget.error.message} before synthesis`)
            : (state.budget.error ?? error)));
      await this.emit({
        ...trace,
        type: "run_error",
        error: errorMessage(failure),
        usage: state.usage.snapshot(),
      });
      throw failure;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsubscribeBudget();
      unsubscribe();
      runtime?.dispose();
    }
  }

  private async emitToolEvent(trace: RLMEventBase, event: AgentEvent): Promise<void> {
    if (event.type === "tool_execution_start" && event.toolName === "javascript") {
      await this.emit({
        ...trace,
        type: "javascript_start",
        toolCallId: event.toolCallId,
        code: typeof event.args?.code === "string" ? event.args.code : "",
      });
    } else if (event.type === "tool_execution_end" && event.toolName === "javascript") {
      await this.emit({
        ...trace,
        type: "javascript_end",
        toolCallId: event.toolCallId,
        output: toolResultText(event.result),
        isError: event.isError,
      });
    }
  }

  private async emit(event: RLMEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }
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
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return (
    content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n") ?? ""
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finalResponse(messages: readonly unknown[]): string {
  const response = messages.findLast(
    (message): message is AssistantMessage =>
      typeof message === "object" &&
      message !== null &&
      (message as AssistantMessage).role === "assistant",
  );
  if (!response) throw new Error("RLM completed without an assistant response");
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `RLM model stopped with ${response.stopReason}`);
  }
  const text = contentText(response.content).trim();
  if (!text) throw new Error("RLM completed without a textual answer");
  return text;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
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

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name);
}
