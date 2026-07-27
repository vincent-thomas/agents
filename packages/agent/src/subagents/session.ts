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

export type SubagentSession = Awaited<
  ReturnType<typeof createAgentSession>
>["session"];

export interface Subagent {
  definition: SubagentDefinition;
  session: SubagentSession;
  dispose(): void;
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
    extensionFactories: [
      commandPolicyExtension,
      ...(options.extensionFactories ?? []),
    ],
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

  let turnCount = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "turn_end") return;
    turnCount++;
    if (turnCount >= definition.maxTurns) void session.abort();
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
