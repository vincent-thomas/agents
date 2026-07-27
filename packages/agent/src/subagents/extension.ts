import { truncateToVisualLines, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { SubagentDefinition } from "./definitions.ts";
import type { Subagent } from "./session.ts";

export type SubagentToolStatus = "running" | "succeeded" | "failed";

export interface SubagentToolExecution {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: SubagentToolStatus;
}

interface SubagentToolDetails {
  toolTrace: SubagentToolExecution[];
}

export interface SubagentToolContext {
  cwd: string;
  parentPrompt?: string;
  signal?: AbortSignal;
}

export interface SubagentInvocation {
  subagent: Subagent;
  prompt: string;
}

export interface SubagentToolsExtensionOptions {
  definitions: SubagentDefinition[];
  invokeSubagent(
    definition: SubagentDefinition,
    context: SubagentToolContext,
  ): Promise<SubagentInvocation>;
}

class SubagentResultText {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return truncateToVisualLines(this.text, Math.max(1, this.text.length + 1), width).visualLines;
  }

  invalidate(): void {}
}

export function startSubagentToolExecution(
  trace: SubagentToolExecution[],
  id: string,
  name: string,
  args: unknown,
): SubagentToolExecution[] {
  const execution: SubagentToolExecution = {
    id,
    name,
    args:
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {},
    status: "running",
  };
  const existingIndex = trace.findIndex((item) => item.id === id);
  if (existingIndex === -1) return [...trace, execution];

  return trace.map((item, index) => (index === existingIndex ? execution : item));
}

export function finishSubagentToolExecution(
  trace: SubagentToolExecution[],
  id: string,
  failed: boolean,
): SubagentToolExecution[] {
  return trace.map((item) =>
    item.id === id ? { ...item, status: failed ? "failed" : "succeeded" } : item,
  );
}

export function formatSubagentToolExecution(execution: SubagentToolExecution): string {
  const stringArg = (name: string, fallback: string): string => {
    const value = execution.args[name];
    return typeof value === "string" ? value : fallback;
  };

  switch (execution.name) {
    case "read": {
      const path = stringArg("path", "...");
      const offset = execution.args.offset;
      const limit = execution.args.limit;
      if (typeof offset !== "number" && typeof limit !== "number") return `read ${path}`;
      const start = typeof offset === "number" ? offset : 1;
      const end = typeof limit === "number" ? start + limit - 1 : undefined;
      return `read ${path}:${start}${end === undefined ? "" : `-${end}`}`;
    }
    case "grep":
      return `grep /${stringArg("pattern", "")}/ in ${stringArg("path", ".")}`;
    case "find":
      return `find ${stringArg("pattern", "*")} in ${stringArg("path", ".")}`;
    case "ls":
      return `ls ${stringArg("path", ".")}`;
    case "bash":
      return `$ ${stringArg("command", "...")}`;
    default:
      return execution.name;
  }
}

export function formatSubagentResult(text: string | undefined): string {
  if (!text || text.trim().length === 0) {
    return "The sub-agent did not return an answer.";
  }
  return text;
}

export function createSubagentToolsExtension(options: SubagentToolsExtensionOptions) {
  return function (pi: ExtensionAPI) {
    for (const definition of options.definitions) {
      const acceptsParentPrompt = definition.prompt === "parent";
      const parameters = acceptsParentPrompt
        ? Type.Object({
            task: Type.String({
              description: `The task to delegate to the ${definition.name} sub-agent`,
            }),
          })
        : Type.Object({});

      pi.registerTool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        promptSnippet: definition.description,
        parameters,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const parentPrompt =
            acceptsParentPrompt && "task" in params && typeof params.task === "string"
              ? params.task
              : undefined;
          let toolTrace: SubagentToolExecution[] = [];
          const details = (): SubagentToolDetails => ({ toolTrace });
          const notify = () =>
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: parentPrompt ? `${definition.label}: ${parentPrompt}` : definition.label,
                },
              ],
              details: details(),
            });
          notify();

          const invocation = await options.invokeSubagent(definition, {
            cwd: ctx.cwd,
            parentPrompt,
            signal,
          });
          const { subagent, prompt } = invocation;
          const { session } = subagent;

          const unsubscribe = session.subscribe((event) => {
            if (event.type === "tool_execution_start") {
              toolTrace = startSubagentToolExecution(
                toolTrace,
                event.toolCallId,
                event.toolName,
                event.args,
              );
              notify();
            } else if (event.type === "tool_execution_end") {
              toolTrace = finishSubagentToolExecution(toolTrace, event.toolCallId, event.isError);
              notify();
            }
          });

          let resultText: string | undefined;
          try {
            await session.prompt(prompt);
            resultText = session.getLastAssistantText();
          } finally {
            unsubscribe();
            subagent.dispose();
          }

          return {
            content: [
              {
                type: "text" as const,
                text: formatSubagentResult(resultText),
              },
            ],
            details: details(),
          };
        },
        renderResult(result, { expanded, isPartial }, theme, context) {
          const content = result.content.find((item) => item.type === "text");
          const resultText = content?.type === "text" ? theme.fg("toolOutput", content.text) : "";
          const details = result.details as SubagentToolDetails | undefined;

          if (!expanded) return new SubagentResultText(resultText);

          const parentPrompt =
            acceptsParentPrompt && "task" in context.args && typeof context.args.task === "string"
              ? context.args.task
              : undefined;
          let text = theme.fg(
            "toolOutput",
            parentPrompt ? `${definition.label}: ${parentPrompt}` : definition.label,
          );
          if (details?.toolTrace.length) {
            text += `\n\n${theme.fg("muted", "Sub-agent tools:")}`;
            for (const execution of details.toolTrace) {
              const marker =
                execution.status === "running"
                  ? theme.fg("warning", "…")
                  : execution.status === "failed"
                    ? theme.fg("error", "✗")
                    : theme.fg("success", "✓");
              text += `\n${marker} ${theme.fg("toolOutput", formatSubagentToolExecution(execution))}`;
            }
          }
          if (!isPartial && resultText) text += `\n\n${resultText}`;

          return new SubagentResultText(text);
        },
      });
    }
  };
}
