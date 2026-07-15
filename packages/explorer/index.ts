/**
 * agent-explorer — a read-only exploration sub-agent, run in-process via the
 * Pi SDK (not a subprocess). ExtensionAPI has no built-in way to spawn a
 * nested session from a tool handler, so this imports createAgentSession
 * directly from the same package ExtensionAPI comes from.
 *
 * Kept deliberately lean and isolated from the parent session:
 * - tools allowlist restricts it to read/grep/find/ls — no write, edit, bash.
 * - resourceLoader has all discovery (extensions, skills, AGENTS.md, context
 *   files) turned off, so it never inherits agent-lord's own extensions,
 *   system prompt, or skills. That would both bloat its context and re-enable
 *   behavior that makes no sense for a session that can't write or run
 *   commands.
 * - model and thinking level are supplied explicitly by the host, independent
 *   of whatever model agent-lord itself is running.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type CreateAgentSessionOptions,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Object as TObject, String as TString } from "typebox";
import { buildExplorePrompt, formatExploreResult, hasExceededTurnLimit } from "./logic.ts";

export interface ExploreExtensionOptions {
  /** Model for the nested exploration session. */
  model: Model<any>;
  /** Thinking level for the nested exploration session. */
  thinkingLevel: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
}

export function createExploreExtension(options: ExploreExtensionOptions) {
  const { model, thinkingLevel } = options;

  return function (pi: ExtensionAPI) {
    pi.registerTool({
      name: "explore",
      label: "Explore",
      description:
        "Delegate a read-only code search/exploration question to a separate, " +
        "cheaper sub-agent instead of doing many raw read/grep calls yourself. " +
        "Best for broad or multi-file questions ('where is X', 'how does Y work'). " +
        "Returns a terse, distilled answer with file:line references. The " +
        "sub-agent cannot write, edit, or run shell commands.",
      promptSnippet: "Delegate a read-only exploration query",
      parameters: TObject({
        query: TString({
          description:
            "The exploration question to answer, e.g. 'where is the retry logic for CI polling?'",
        }),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const notify = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
        notify(`Exploring: ${params.query}`);

        const agentDir = getAgentDir();
        const resourceLoader = new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        });
        await resourceLoader.reload();

        const { session } = await createAgentSession({
          cwd: ctx.cwd,
          agentDir,
          model,
          thinkingLevel,
          tools: ["read", "grep", "find", "ls"],
          resourceLoader,
          sessionManager: SessionManager.inMemory(ctx.cwd),
        });

        let turnCount = 0;
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "turn_end") {
            turnCount++;
            if (hasExceededTurnLimit(turnCount)) {
              void session.abort();
            }
          }
        });

        const onAbort = () => void session.abort();
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
          await session.prompt(buildExplorePrompt(params.query));
        } finally {
          unsubscribe();
          signal?.removeEventListener("abort", onAbort);
          session.dispose();
        }

        const text = formatExploreResult(session.getLastAssistantText());
        return { content: [{ type: "text" as const, text }] };
      },
    });
  };
}
