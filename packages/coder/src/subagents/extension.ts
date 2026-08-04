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
  subagent?: SubagentTrace;
}

export interface SubagentTrace {
  name: string;
  label: string;
  prompt?: string;
  result?: string;
  toolTrace: SubagentToolExecution[];
}

interface SubagentToolDetails {
  subagent: SubagentTrace;
}

interface LegacySubagentToolDetails {
  toolTrace: SubagentToolExecution[];
}

export interface SubagentToolContext {
  cwd: string;
  parentPrompt?: string;
  parentToolNames: string[];
  signal?: AbortSignal;
}

export interface SubagentInvocation {
  subagent: Subagent;
  prompt: string;
  run?(onProgress: (text: string) => void): Promise<string | undefined>;
}

export interface SubagentToolsExtensionOptions {
  definitions: SubagentDefinition[];
  invokeSubagent(
    definition: SubagentDefinition,
    context: SubagentToolContext,
  ): Promise<SubagentInvocation>;
}

export interface SubagentCommandExtensionOptions {
  definition: SubagentDefinition;
  invokeSubagent(context: SubagentToolContext): Promise<SubagentInvocation>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSubagentToolExecution(value: unknown): value is SubagentToolExecution {
  if (!isRecord(value) || !isRecord(value.args)) return false;
  if (typeof value.id !== "string" || typeof value.name !== "string") return false;
  if (value.status !== "running" && value.status !== "succeeded" && value.status !== "failed") {
    return false;
  }
  return value.subagent === undefined || isSubagentTrace(value.subagent);
}

function isSubagentTrace(value: unknown): value is SubagentTrace {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string" || typeof value.label !== "string") return false;
  if (value.prompt !== undefined && typeof value.prompt !== "string") return false;
  if (value.result !== undefined && typeof value.result !== "string") return false;
  return Array.isArray(value.toolTrace) && value.toolTrace.every(isSubagentToolExecution);
}

function traceFromToolResult(result: unknown): SubagentTrace | undefined {
  if (!isRecord(result) || !isRecord(result.details)) return undefined;
  return isSubagentTrace(result.details.subagent) ? result.details.subagent : undefined;
}

function legacyTraceFromDetails(details: unknown): SubagentToolExecution[] {
  if (!isRecord(details) || !Array.isArray(details.toolTrace)) return [];
  return details.toolTrace.every(isSubagentToolExecution)
    ? (details as unknown as LegacySubagentToolDetails).toolTrace
    : [];
}

export function updateSubagentToolExecution(
  trace: SubagentToolExecution[],
  id: string,
  result: unknown,
): SubagentToolExecution[] {
  const subagent = traceFromToolResult(result);
  if (!subagent) return trace;
  return trace.map((item) => (item.id === id ? { ...item, subagent } : item));
}

export function finishSubagentToolExecution(
  trace: SubagentToolExecution[],
  id: string,
  failed: boolean,
  result?: unknown,
): SubagentToolExecution[] {
  const subagent = traceFromToolResult(result);
  return trace.map((item) =>
    item.id === id
      ? {
          ...item,
          status: failed ? "failed" : "succeeded",
          ...(subagent ? { subagent } : {}),
        }
      : item,
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

export async function runSubagentInvocation(
  invocation: SubagentInvocation,
  onProgress: (text: string) => void = () => {},
): Promise<string> {
  const { subagent, prompt } = invocation;
  try {
    if (invocation.run) {
      return formatSubagentResult(await invocation.run(onProgress));
    }
    await subagent.session.prompt(prompt);
    return formatSubagentResult(subagent.session.getLastAssistantText());
  } finally {
    subagent.dispose();
  }
}

export function createSubagentCommandExtension(options: SubagentCommandExtensionOptions) {
  return function (pi: ExtensionAPI) {
    const { definition } = options;
    pi.registerCommand(definition.name, {
      description: definition.description,
      handler: async (args, ctx) => {
        await ctx.waitForIdle();
        const task = args.trim() || definition.description;
        const statusKey = `subagent:${definition.name}`;
        ctx.ui.setStatus(statusKey, `${definition.label} running…`);
        try {
          const invocation = await options.invokeSubagent({
            cwd: ctx.cwd,
            parentPrompt: task,
            parentToolNames: pi.getActiveTools(),
          });
          const result = await runSubagentInvocation(invocation, (text) => {
            ctx.ui.setStatus(statusKey, text);
          });
          pi.sendMessage(
            {
              customType: "subagent-feedback",
              content: `${definition.label} sub-agent feedback:\n\n${result}`,
              display: true,
              details: { name: definition.name, task },
            },
            { triggerTurn: true },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`${definition.label} failed: ${message}`, "error");
        } finally {
          ctx.ui.setStatus(statusKey, undefined);
        }
      },
    });
  };
}

export function createSubagentToolsExtension(options: SubagentToolsExtensionOptions) {
  return function (pi: ExtensionAPI) {
    if (options.definitions.length === 0) return;

    const byName = new Map(options.definitions.map((definition) => [definition.name, definition]));
    const variants = options.definitions.map((definition) =>
      definition.prompt === "parent"
        ? Type.Object({
            actor: Type.Literal(definition.name),
            prompt: Type.String({
              description: `The task to delegate to the ${definition.name} sub-agent`,
            }),
          })
        : Type.Object({ actor: Type.Literal(definition.name) }),
    ) as [ReturnType<typeof Type.Object>, ...ReturnType<typeof Type.Object>[]];

    pi.registerTool({
      name: "agent",
      label: "Agent",
      description: [
        "Delegate work to an available sub-agent.",
        ...options.definitions.map((definition) => `${definition.name}: ${definition.description}`),
      ].join("\n"),
      parameters: Type.Union(variants),
      renderCall(args, theme) {
        const actor = typeof args.actor === "string" ? ` ${args.actor}` : "";
        return new SubagentResultText(theme.fg("toolTitle", theme.bold(`agent${actor}`)));
      },
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const definition = byName.get(params.actor);
        if (!definition) throw new Error(`Sub-agent '${params.actor}' is not available`);
        const acceptsParentPrompt = definition.prompt === "parent";
        const parentPrompt =
          acceptsParentPrompt && "prompt" in params && typeof params.prompt === "string"
            ? params.prompt
            : undefined;
        let toolTrace: SubagentToolExecution[] = [];
        let workflowStatus: string | undefined;
        let resultText: string | undefined;
        const details = (): SubagentToolDetails => ({
          subagent: {
            name: definition.name,
            label: definition.label,
            ...(parentPrompt ? { prompt: parentPrompt } : {}),
            ...(resultText ? { result: resultText } : {}),
            toolTrace,
          },
        });
        const notify = () =>
          onUpdate?.({
            content: [
              {
                type: "text",
                text: workflowStatus ?? parentPrompt ?? definition.label,
              },
            ],
            details: details(),
          });
        notify();

        const invocation = await options.invokeSubagent(definition, {
          cwd: ctx.cwd,
          parentPrompt,
          parentToolNames: pi.getActiveTools(),
          signal,
        });
        const { session } = invocation.subagent;

        const unsubscribe = session.subscribe((event) => {
          if (event.type === "tool_execution_start") {
            toolTrace = startSubagentToolExecution(
              toolTrace,
              event.toolCallId,
              event.toolName,
              event.args,
            );
            notify();
          } else if (event.type === "tool_execution_update") {
            toolTrace = updateSubagentToolExecution(
              toolTrace,
              event.toolCallId,
              event.partialResult,
            );
            notify();
          } else if (event.type === "tool_execution_end") {
            toolTrace = finishSubagentToolExecution(
              toolTrace,
              event.toolCallId,
              event.isError,
              event.result,
            );
            notify();
          }
        });

        try {
          resultText = await runSubagentInvocation(invocation, (text) => {
            workflowStatus = text;
            notify();
          });
        } finally {
          unsubscribe();
        }

        return {
          content: [
            {
              type: "text" as const,
              text: resultText,
            },
          ],
          details: details(),
        };
      },
      renderResult(result, { expanded, isPartial }, theme, context) {
        const content = result.content.find((item) => item.type === "text");
        const rawResultText = content?.type === "text" ? content.text : "";
        const resultText = theme.fg("toolOutput", rawResultText);
        const details = result.details;

        if (!expanded) return new SubagentResultText(resultText);

        const actor = context.args.actor;
        const definition = typeof actor === "string" ? byName.get(actor) : undefined;
        if (!definition) return new SubagentResultText(resultText);
        const acceptsParentPrompt = definition.prompt === "parent";
        const parentPrompt =
          acceptsParentPrompt && "prompt" in context.args && typeof context.args.prompt === "string"
            ? context.args.prompt
            : undefined;
        const root =
          isRecord(details) && isSubagentTrace(details.subagent)
            ? details.subagent
            : {
                name: definition.name,
                label: definition.label,
                ...(parentPrompt ? { prompt: parentPrompt } : {}),
                ...(!isPartial && rawResultText ? { result: rawResultText } : {}),
                toolTrace: legacyTraceFromDetails(details),
              };
        const renderTrace = (
          trace: SubagentTrace,
          depth: number,
          includeHeader = true,
          partialRoot = false,
        ): string[] => {
          const indent = "  ".repeat(depth);
          const lines: string[] = [];
          if (includeHeader) {
            const header =
              partialRoot && depth === 0
                ? (trace.prompt ?? trace.label)
                : trace.prompt
                  ? `${trace.label}: ${trace.prompt}`
                  : trace.label;
            lines.push(
              ...header.split("\n").map((line) => `${indent}${theme.fg("toolOutput", line)}`),
            );
          }
          if (trace.toolTrace.length) {
            lines.push("", `${indent}${theme.fg("muted", "Sub-agent tools:")}`);
            for (const execution of trace.toolTrace) {
              const marker =
                execution.status === "running"
                  ? theme.fg("warning", "…")
                  : execution.status === "failed"
                    ? theme.fg("error", "✗")
                    : theme.fg("success", "✓");
              const summary = execution.subagent
                ? execution.subagent.prompt
                  ? `${execution.subagent.label}: ${execution.subagent.prompt}`
                  : execution.subagent.label
                : formatSubagentToolExecution(execution);
              const summaryLines = summary.split("\n");
              lines.push(`${indent}${marker} ${theme.fg("toolOutput", summaryLines[0]!)}`);
              lines.push(
                ...summaryLines
                  .slice(1)
                  .map((line) => `${indent}  ${theme.fg("toolOutput", line)}`),
              );
              if (execution.subagent) {
                lines.push(...renderTrace(execution.subagent, depth + 1, false));
              }
            }
          }
          if (trace.result) {
            lines.push(
              "",
              ...trace.result.split("\n").map((line) => `${indent}${theme.fg("toolOutput", line)}`),
            );
          }
          return lines;
        };
        const traceForRender = isPartial ? { ...root, result: undefined } : root;
        return new SubagentResultText(renderTrace(traceForRender, 0, true, isPartial).join("\n"));
      },
    });
  };
}
