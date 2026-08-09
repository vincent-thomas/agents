import {
  Agent,
  type AgentEvent,
  type AgentOptions,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { contentText, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createJavascriptTool } from "./javascript-tool.ts";
import { buildLeafPrompt, RLM_SYSTEM_PROMPT } from "./prompt.ts";
import { JavaScriptRuntime, type JavaScriptRuntimeOptions } from "./runtime.ts";

export interface RLMOptions {
  model: Model<any>;
  context: string;
  getApiKey?: AgentOptions["getApiKey"];
  onEvent?: (event: RLMEvent) => Promise<void> | void;
  maxDepth?: number;
  maxModelCalls?: number;
  executionTimeoutMs?: number;
  maxOutputChars?: number;
}

export type RLMEvent =
  | {
      type: "run_start";
      depth: number;
      prompt: string;
      contextLength: number;
      isLeaf: boolean;
    }
  | { type: "agent_event"; depth: number; event: AgentEvent }
  | { type: "run_end"; depth: number; result: string }
  | { type: "run_error"; depth: number; error: string };

export interface RLMDependencies {
  streamFn?: StreamFn;
  createRuntime?: (options: JavaScriptRuntimeOptions) => JavaScriptRuntime;
}

interface ResolvedOptions {
  model: Model<any>;
  context: string;
  getApiKey: AgentOptions["getApiKey"];
  onEvent: RLMOptions["onEvent"];
  maxDepth: number;
  maxModelCalls: number;
  executionTimeoutMs: number | undefined;
  maxOutputChars: number | undefined;
}

class ModelCallBudget {
  used = 0;

  constructor(readonly maximum: number) {}

  acquire(): boolean {
    if (this.used >= this.maximum) return false;
    this.used += 1;
    return true;
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

  run(prompt: string): Promise<string> {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return Promise.reject(new TypeError("prompt must be a non-empty string"));
    }
    const budget = new ModelCallBudget(this.options.maxModelCalls);
    return this.runAtDepth(prompt, this.options.context, 0, budget);
  }

  private async runAtDepth(
    prompt: string,
    context: string,
    depth: number,
    budget: ModelCallBudget,
  ): Promise<string> {
    if (!budget.acquire()) {
      throw new Error(`RLM exceeded its ${budget.maximum} model-call limit`);
    }

    const isLeaf = depth >= this.options.maxDepth;
    await this.emit({
      type: "run_start",
      depth,
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
        llm: (childPrompt, childContext) =>
          this.runAtDepth(childPrompt, childContext ?? context, depth + 1, budget),
      });
    }

    let stoppedForBudget = false;
    const agent = new Agent({
      initialState: {
        systemPrompt: isLeaf
          ? "Answer the task using the delegated external context supplied by the user."
          : RLM_SYSTEM_PROMPT,
        model: this.options.model,
        thinkingLevel: "off",
        tools: runtime ? [createJavascriptTool(runtime)] : [],
      },
      streamFn: this.streamFn,
      getApiKey: this.options.getApiKey,
      shouldStopAfterTurn: ({ toolResults }) => {
        if (toolResults.length === 0) return false;
        if (budget.acquire()) return false;
        stoppedForBudget = true;
        return true;
      },
    });
    const unsubscribe = agent.subscribe((event) =>
      this.emit({ type: "agent_event", depth, event }),
    );

    try {
      await agent.prompt(isLeaf ? buildLeafPrompt(prompt, context) : prompt);
      if (stoppedForBudget) {
        throw new Error(`RLM exceeded its ${budget.maximum} model-call limit before synthesis`);
      }
      const result = finalResponse(agent.state.messages);
      await this.emit({ type: "run_end", depth, result });
      return result;
    } catch (error) {
      await this.emit({ type: "run_error", depth, error: errorMessage(error) });
      throw error;
    } finally {
      unsubscribe();
      runtime?.dispose();
    }
  }

  private async emit(event: RLMEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name);
}
