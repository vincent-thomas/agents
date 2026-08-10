import type { RLMChildHandle, RLMEvent } from "../src/index.ts";

const DEFAULT_ERROR_OUTPUT_LIMIT = 240;

type EventWriter = (message: string) => void;

/**
 * Maintains the run tree while rendering append-only progress lines.
 *
 * Run events can arrive interleaved when siblings execute concurrently. The
 * prefix is therefore derived from identity, never from the last event or a
 * mutable "current depth".
 */
export class RLMEventRenderer {
  private readonly runs = new Map<number, RunBranch>();
  private readonly runHandles = new Map<number, RLMChildHandle>();
  private readonly outputLimit: number;
  private rootActive = false;

  constructor(outputLimit = DEFAULT_ERROR_OUTPUT_LIMIT) {
    this.outputLimit = Math.max(0, outputLimit);
  }

  format(event: RLMEvent): string {
    this.observe(event);
    const prefix = `[rlm ${this.pathFor(event)}]`;
    switch (event.type) {
      case "run_start": {
        const kind = event.parentRunId === undefined ? "start" : "recursive start";
        return `${prefix} ${kind}: ${singleLine(event.prompt)} (external context: ${event.contextLength} chars)`;
      }
      case "model_start":
        return `${prefix} waiting for model (call ${event.modelCall})`;
      case "model_end":
        return `${prefix} model complete (${event.stopReason})`;
      case "javascript_start":
        return `${prefix} javascript start`;
      case "javascript_end":
        return event.isError
          ? `${prefix} javascript error: ${truncate(errorSummary(event.output), this.outputLimit)}`
          : `${prefix} javascript complete`;
      case "run_end":
        return `${prefix} complete`;
      case "run_error":
        return `${prefix} error: ${truncate(singleLine(event.error), this.outputLimit)}`;
      case "child_spawn":
        return `${prefix} spawned ${branchName(event.handle)}${event.tier ? ` [${event.tier}]` : ""} (context: ${event.contextLength} chars)`;
      case "child_start":
        return `${prefix} child started`;
      case "child_end":
        return `${prefix} child ${event.result.status}`;
      case "child_error":
        return `${prefix} child failed: ${truncate(singleLine(event.result.error?.message ?? "unknown error"), this.outputLimit)}`;
      case "child_cancel":
        return `${prefix} child cancelled`;
      default: {
        const exhaustiveEvent: never = event;
        return `${prefix} unknown event: ${String(exhaustiveEvent)}`;
      }
    }
  }

  private observe(event: RLMEvent): void {
    if (event.type === "run_start" && event.parentRunId === undefined) {
      if (!this.rootActive) {
        this.runs.clear();
        this.runHandles.clear();
      }
      this.rootActive = true;
    }
    if (event.runId === 0 && (event.type === "run_end" || event.type === "run_error")) {
      this.rootActive = false;
    }
    if (
      event.type === "child_start" ||
      event.type === "child_end" ||
      event.type === "child_error" ||
      event.type === "child_cancel"
    ) {
      const handle = event.type === "child_start" ? event.handle : event.result.handle;
      this.runHandles.set(event.runId, handle);
    }

    const current = this.runs.get(event.runId);
    if (current) {
      if (event.parentRunId !== undefined) current.parentRunId = event.parentRunId;
      return;
    }
    this.runs.set(event.runId, {
      parentRunId: event.parentRunId,
      path: undefined,
    });
  }

  private pathFor(event: RLMEvent): string {
    const run = this.runs.get(event.runId) ?? {
      parentRunId: event.parentRunId,
      path: undefined,
    };
    if (!this.runs.has(event.runId)) this.runs.set(event.runId, run);
    if (run.path) return run.path;

    if (run.parentRunId === undefined || event.runId === 0) {
      run.path = "root";
      return run.path;
    }

    const parentPath = this.pathForRun(run.parentRunId);
    const handle = this.runHandles.get(event.runId);
    run.path = `${parentPath}/${handle ? branchName(handle) : `run#${event.runId}`}`;
    return run.path;
  }

  private pathForRun(runId: number): string {
    const existing = this.runs.get(runId);
    if (!existing) return runId === 0 ? "root" : `run#${runId}`;
    if (existing.path) return existing.path;
    if (existing.parentRunId === undefined || runId === 0) {
      existing.path = "root";
      return existing.path;
    }
    const parentPath = this.pathForRun(existing.parentRunId);
    const handle = this.runHandles.get(runId);
    existing.path = `${parentPath}/${handle ? branchName(handle) : `run#${runId}`}`;
    return existing.path;
  }
}

/** Create one stateful tracer for one top-level RLM run. */
export function createRLMEventTracer(
  outputLimit?: number,
  write: EventWriter = console.error,
): (event: RLMEvent) => void {
  const renderer = new RLMEventRenderer(outputLimit);
  return (event) => write(renderer.format(event));
}

/** Render one event without tree history, useful for isolated event inspection. */
export function traceRLMEvent(
  event: RLMEvent,
  outputLimit?: number,
  write: EventWriter = console.error,
): void {
  write(formatRLMEvent(event, outputLimit));
}

export function formatRLMEvent(event: RLMEvent, outputLimit?: number): string {
  return new RLMEventRenderer(outputLimit).format(event);
}

function branchName(handle: RLMChildHandle): string {
  const name = handle.name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${name || `child-${handle.id}`}#${handle.id}`;
}

function errorSummary(output: string): string {
  const firstLine = output.split(/\r?\n/, 1)[0] || "unknown error";
  return singleLine(firstLine);
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}... (${value.length - maximum} chars omitted)`;
}

interface RunBranch {
  parentRunId: number | undefined;
  path: string | undefined;
}
