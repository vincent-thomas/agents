import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createCommandPolicyExtension } from "@vt-agent/command-policy";
import type { SubagentDefinition } from "./definitions.ts";

export interface CreateSubagentSessionOptions {
  definition: SubagentDefinition;
  cwd: string;
  model: Model<any>;
  agentDir?: string;
  extensionFactories?: ExtensionFactory[];
  customTools?: ToolDefinition[];
  signal?: AbortSignal;
}

export type SubagentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export interface Subagent {
  definition: SubagentDefinition;
  session: SubagentSession;
  dispose(): void;
}

export interface SubagentTurnLimitState {
  turnCount: number;
  finalTurnRequested: boolean;
}

export type SubagentTurnLimitAction = "continue" | "request_final" | "abort";

export function advanceSubagentTurnLimit(
  state: SubagentTurnLimitState,
  maxTurns: number,
): { state: SubagentTurnLimitState; action: SubagentTurnLimitAction } {
  const next = { ...state, turnCount: state.turnCount + 1 };
  if (next.turnCount < maxTurns) return { state: next, action: "continue" };
  if (!next.finalTurnRequested) {
    return {
      state: { ...next, finalTurnRequested: true },
      action: "request_final",
    };
  }
  return { state: next, action: "abort" };
}

export function subagentToolNames(definition: SubagentDefinition): string[] {
  return [...new Set([...definition.tools, ...definition.subagents])];
}

/**
 * Creates an isolated sub-agent from a Markdown definition without deciding
 * how the caller exposes or prompts it. Tools, commands, and workflows can all
 * reuse this boundary; registering an LLM-callable tool is only one adapter.
 */
export async function createSubagentSession(
  options: CreateSubagentSessionOptions,
): Promise<Subagent> {
  if (options.signal?.aborted) {
    throw new DOMException("Sub-agent invocation aborted", "AbortError");
  }

  const { definition } = options;
  const agentDir = options.agentDir ?? getAgentDir();
  const commandPolicyExtension = createCommandPolicyExtension({
    entries: definition.commandPolicy,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [commandPolicyExtension, ...(options.extensionFactories ?? [])],
    systemPromptOverride: () => definition.systemPrompt,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    model: options.model,
    thinkingLevel: definition.thinking,
    tools: subagentToolNames(definition),
    customTools: options.customTools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd),
  });

  const onAbort = () => void session.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    options.signal.removeEventListener("abort", onAbort);
    session.dispose();
    throw new DOMException("Sub-agent invocation aborted", "AbortError");
  }

  let turnLimitState: SubagentTurnLimitState = {
    turnCount: 0,
    finalTurnRequested: false,
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "turn_end" || definition.maxTurns === undefined) return;
    const transition = advanceSubagentTurnLimit(turnLimitState, definition.maxTurns);
    turnLimitState = transition.state;
    if (transition.action === "request_final") {
      void session.sendCustomMessage(
        {
          customType: "subagent-turn-limit",
          content: "Stop using tools and return your best final answer now.",
          display: false,
        },
        { deliverAs: "steer" },
      );
    } else if (transition.action === "abort") {
      void session.abort();
    }
  });

  let disposed = false;
  return {
    definition,
    session,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
      session.dispose();
    },
  };
}
