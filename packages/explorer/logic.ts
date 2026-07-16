/**
 * logic.ts — pure helpers for the explore sub-agent. No Pi imports: the SDK
 * wiring (createAgentSession, tool registration) lives in index.ts.
 */

/** Safety net for a runaway exploration loop — the SDK exposes no maxTurns option. */
export const MAX_EXPLORE_TURNS = 15;

export function hasExceededTurnLimit(turnCount: number): boolean {
  return turnCount >= MAX_EXPLORE_TURNS;
}

export type ExploreToolStatus = "running" | "succeeded" | "failed";

export interface ExploreToolExecution {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ExploreToolStatus;
}

export function startExploreToolExecution(
  trace: ExploreToolExecution[],
  id: string,
  name: string,
  args: unknown,
): ExploreToolExecution[] {
  const execution: ExploreToolExecution = {
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

export function finishExploreToolExecution(
  trace: ExploreToolExecution[],
  id: string,
  failed: boolean,
): ExploreToolExecution[] {
  return trace.map((item) =>
    item.id === id ? { ...item, status: failed ? "failed" : "succeeded" } : item,
  );
}

export function formatExploreToolExecution(execution: ExploreToolExecution): string {
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
    default:
      return execution.name;
  }
}

export function buildExplorePrompt(query: string): string {
  return [
    "You are a read-only code exploration assistant. You can only read files,",
    "search (grep/find), and list directories — you cannot write, edit, or run",
    "shell commands.",
    "",
    "Answer the query below as concisely as possible:",
    "- Give a direct, factual answer with file:line references where relevant.",
    "- No preamble, no restating the question, no narration of your steps.",
    "- If you can't find something, say so briefly instead of guessing.",
    "",
    `Query: ${query}`,
  ].join("\n");
}

export function formatExploreResult(text: string | undefined): string {
  if (!text || text.trim().length === 0) {
    return "The exploration sub-agent did not return an answer.";
  }
  return text;
}
