import type { RLMChildHandle, RLMChildResult, RLMEvent } from "../src/index.ts";

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
  private rootRunId: number | undefined;

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
      this.runs.clear();
      this.runHandles.clear();
      this.rootRunId = event.runId;
    }
    if (event.type === "run_end" || event.type === "run_error") {
      if (event.runId === this.rootRunId) this.rootRunId = undefined;
    }
    if (
      event.type === "child_start" ||
      event.type === "child_end" ||
      event.type === "child_error" ||
      event.type === "child_cancel"
    ) {
      const handle = event.type === "child_start" ? event.handle : event.result.handle;
      this.runHandles.set(event.runId, handle);
      // A child can emit run_start before its child_start observer callback is
      // delivered. Let the later lifecycle event replace that temporary path.
      const branch = this.runs.get(event.runId);
      if (branch?.path?.includes("run#")) branch.path = undefined;
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

    if (run.parentRunId === undefined || event.runId === this.rootRunId) {
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
    if (!existing) return runId === this.rootRunId ? "root" : `run#${runId}`;
    if (existing.path) return existing.path;
    if (existing.parentRunId === undefined || runId === this.rootRunId) {
      existing.path = "root";
      return existing.path;
    }
    const parentPath = this.pathForRun(existing.parentRunId);
    const handle = this.runHandles.get(runId);
    existing.path = `${parentPath}/${handle ? branchName(handle) : `run#${runId}`}`;
    return existing.path;
  }
}

export interface RLMEventTracerOptions {
  outputLimit?: number;
  write?: EventWriter;
  /** Explicitly select dashboard mode. Defaults to stderr.isTTY only. */
  tty?: boolean;
  color?: boolean;
  maxModelCalls?: number;
  maxDepth?: number;
  /** Maximum terminal columns used by each plain dashboard line. */
  columns?: number;
  now?: () => number;
}

/** Create a stateful tracer. TTY mode redraws one dashboard; other streams append compact lines. */
export function createRLMEventTracer(options?: RLMEventTracerOptions): (event: RLMEvent) => void;
export function createRLMEventTracer(
  outputLimit?: number,
  write?: EventWriter,
  options?: Omit<RLMEventTracerOptions, "outputLimit" | "write">,
): (event: RLMEvent) => void;
export function createRLMEventTracer(
  optionsOrLimit: RLMEventTracerOptions | number | undefined = undefined,
  legacyWrite?: EventWriter,
  legacyOptions: Omit<RLMEventTracerOptions, "outputLimit" | "write"> = {},
): (event: RLMEvent) => void {
  const options: RLMEventTracerOptions =
    typeof optionsOrLimit === "number"
      ? { ...legacyOptions, outputLimit: optionsOrLimit, write: legacyWrite }
      : optionsOrLimit === undefined
        ? { ...legacyOptions, write: legacyWrite }
        : { ...optionsOrLimit };
  const suppliedWrite = options.write !== undefined || legacyWrite !== undefined;
  const legacyPositional = typeof optionsOrLimit === "number" || legacyWrite !== undefined;
  const tty =
    options.tty ?? (legacyPositional ? false : !suppliedWrite && Boolean(process.stderr.isTTY));
  const write =
    options.write ??
    legacyWrite ??
    (tty ? process.stderr.write.bind(process.stderr) : console.error);
  if (!tty) {
    const renderer = new RLMEventRenderer(options.outputLimit);
    return (event) => write(compactFallback(renderer.format(event)));
  }

  const terminalColumns = process.stderr.columns;
  const columns =
    options.columns ??
    (terminalColumns !== undefined && terminalColumns > 0 ? terminalColumns : 100);
  const dashboard = new RLMEventDashboard({ ...options, columns });
  const color = options.color ?? process.env.NO_COLOR === undefined;
  let previousLines = 0;
  let first = true;
  return (event) => {
    if (dashboard.isComplete() && !isTopLevelRunStart(event)) return;
    const snapshot = dashboard.render(event);
    const lines = snapshot.split("\n");
    const writtenLines = Math.max(previousLines, lines.length);
    let frame = first ? "" : `\u001b[${previousLines}A`;
    for (const line of lines) frame += `\u001b[2K${colorizeDashboardLine(line, color)}\n`;
    for (let index = lines.length; index < writtenLines; index++) frame += "\u001b[2K\n";
    write(frame);
    previousLines = writtenLines;
    first = false;
  };
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

function isTopLevelRunStart(event: RLMEvent): boolean {
  return event.type === "run_start" && event.parentRunId === undefined;
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

/** Stateful plain-text model used by the interactive ANSI adapter. */
export class RLMEventDashboard {
  /** Running nodes are keyed by their actual runId, never by handle.id. */
  private readonly nodes = new Map<number, DashboardNode>();
  /** A spawn is observed on the parent before the child has a runId. */
  private readonly pendingNodes = new Map<number, DashboardNode>();
  private readonly outputLimit: number;
  private readonly now: () => number;
  private readonly columns: number;
  private rootId: number | undefined;
  private startedAt: number | undefined;
  private modelCalls = 0;
  private maxDepthSeen = 0;
  private complete = false;

  constructor(
    private readonly options: Pick<
      RLMEventTracerOptions,
      "maxModelCalls" | "maxDepth" | "outputLimit" | "now" | "columns"
    > = {},
  ) {
    this.outputLimit = Math.max(0, options.outputLimit ?? DEFAULT_ERROR_OUTPUT_LIMIT);
    this.now = options.now ?? (() => Date.now());
    this.columns = Math.max(1, Math.floor(options.columns ?? 100));
  }

  /** Apply an event and return a plain-text snapshot (without ANSI control codes). */
  render(event: RLMEvent): string {
    if (!this.complete || isTopLevelRunStart(event)) this.observe(event);
    return this.snapshot();
  }

  snapshot(): string {
    const root = this.rootId === undefined ? undefined : this.nodes.get(this.rootId);
    const elapsed = this.startedAt === undefined ? 0 : Math.max(0, this.now() - this.startedAt);
    const budget = this.options.maxModelCalls;
    const calls =
      budget === undefined
        ? `model calls: ${this.modelCalls}`
        : `model calls: ${this.modelCalls}/${budget}`;
    const depth =
      this.options.maxDepth === undefined
        ? `depth: ${this.maxDepthSeen}`
        : `depth: ${this.maxDepthSeen}/${this.options.maxDepth}`;
    const lines = [
      `RLM trace  ${calls}  active agents: ${this.activeAgents()}  ${depth}  elapsed: ${formatElapsed(elapsed)}`,
    ];
    if (root) this.renderNode(root, "", true, lines, true);
    else lines.push("request — waiting for model");
    return lines.map((line) => truncateDashboardLine(line, this.columns)).join("\n");
  }

  isComplete(): boolean {
    return this.complete;
  }

  private observe(event: RLMEvent): void {
    // A new top-level run starts a new dashboard even when the previous run
    // has already completed. This also handles reused root run IDs.
    if (event.type === "run_start" && event.parentRunId === undefined) {
      this.nodes.clear();
      this.pendingNodes.clear();
      this.rootId = event.runId;
      this.startedAt = this.now();
      this.modelCalls = 0;
      this.maxDepthSeen = event.depth;
      this.complete = false;
    }
    this.maxDepthSeen = Math.max(this.maxDepthSeen, event.depth);

    let node: DashboardNode;
    switch (event.type) {
      case "child_spawn": {
        const parent = this.actualNode(event.runId, event.parentRunId);
        let child = this.pendingNodes.get(event.handle.id);
        if (!child) {
          child = this.newNode(undefined, event.handle.parentRunId);
          this.pendingNodes.set(event.handle.id, child);
        }
        child.name = humanBranchName(event.handle);
        child.parentRunId = event.handle.parentRunId;
        if (child.status === "new") child.status = "waiting for model";
        this.link(parent, child);
        break;
      }
      case "child_start": {
        node = this.attachChild(event.runId, event.handle);
        if (!isTerminal(node.status)) node.status = "waiting for model";
        node.jsError = undefined;
        break;
      }
      case "child_end":
      case "child_error":
      case "child_cancel": {
        const result = event.result;
        node = this.attachChild(event.runId, result.handle);
        node.status = statusForChild(result.status);
        node.jsError = undefined;
        node.error = result.error
          ? truncate(singleLine(result.error.message), this.outputLimit)
          : undefined;
        break;
      }
      default:
        node = this.actualNode(event.runId, event.parentRunId);
        switch (event.type) {
          case "run_start":
            node.parentRunId = event.parentRunId;
            node.name =
              event.parentRunId === undefined ? `request${promptSuffix(event.prompt)}` : node.name;
            node.status = "waiting for model";
            node.jsError = undefined;
            break;
          case "model_start":
            this.modelCalls = Math.max(this.modelCalls, event.modelCall);
            node.status = "reasoning/model";
            break;
          case "model_end":
            node.status = "waiting for model";
            break;
          case "javascript_start":
            node.status = "running JavaScript";
            break;
          case "javascript_end":
            if (event.isError) {
              // Tool failures do not terminate a run: the model can recover.
              node.status = "waiting for model";
              node.jsError = `JavaScript error: ${errorSummary(event.output)}`;
            } else {
              node.status = "waiting for model";
              node.jsError = undefined;
            }
            break;
          case "run_end":
            node.status = "completed";
            node.jsError = undefined;
            node.error = undefined;
            this.modelCalls = Math.max(this.modelCalls, event.usage.modelCalls);
            break;
          case "run_error":
            node.status = "failed";
            node.error = truncate(singleLine(event.error), this.outputLimit);
            this.modelCalls = Math.max(this.modelCalls, event.usage.modelCalls);
            break;
          default: {
            const exhaustiveEvent: never = event;
            void exhaustiveEvent;
          }
        }
        break;
    }
    this.complete = this.rootTerminalAndChildrenTerminal();
  }

  private newNode(runId: number | undefined, parentRunId: number | undefined): DashboardNode {
    return {
      runId,
      parentRunId,
      name: runId === this.rootId ? "request" : "agent",
      status: "new",
      error: undefined,
      jsError: undefined,
      children: [],
    };
  }

  private actualNode(runId: number, parentRunId: number | undefined): DashboardNode {
    const existing = this.nodes.get(runId);
    if (existing) {
      if (parentRunId !== undefined) existing.parentRunId = parentRunId;
      return existing;
    }
    // Normally child_start supplies the handle-to-run mapping. If an event
    // beats that callback, this identity-preserving fallback only adopts a
    // pending placeholder whose handle id happens to equal this runId; it is
    // never used as the primary key or to overwrite an existing run.
    const pending = this.pendingNodes.get(runId);
    if (pending) {
      pending.runId = runId;
      this.pendingNodes.delete(runId);
      this.nodes.set(runId, pending);
      if (parentRunId !== undefined) pending.parentRunId = parentRunId;
      return pending;
    }
    const node = this.newNode(runId, parentRunId);
    this.nodes.set(runId, node);
    if (parentRunId !== undefined) this.link(this.nodes.get(parentRunId), node);
    return node;
  }

  /** Attach a handle's pending placeholder to the actual lifecycle run ID. */
  private attachChild(runId: number, handle: RLMChildHandle): DashboardNode {
    const pending = this.pendingNodes.get(handle.id);
    const existing = this.nodes.get(runId);
    let node: DashboardNode;
    if (pending && existing && pending !== existing) {
      // A run event may have beaten child_start delivery. Merge both objects
      // and replace the parent reference, rather than rendering a duplicate.
      existing.name = pending.name;
      existing.parentRunId = handle.parentRunId;
      existing.children.push(
        ...pending.children.filter((child) => !existing.children.includes(child)),
      );
      this.replaceChildReference(pending, existing);
      node = existing;
    } else if (pending) {
      node = pending;
      node.runId = runId;
      this.nodes.set(runId, node);
    } else {
      node = existing ?? this.actualNode(runId, handle.parentRunId);
    }
    this.pendingNodes.delete(handle.id);
    node.name = humanBranchName(handle);
    node.parentRunId = handle.parentRunId;
    this.link(this.nodes.get(handle.parentRunId), node);
    return node;
  }

  private replaceChildReference(from: DashboardNode, to: DashboardNode): void {
    for (const parent of this.allNodes()) {
      parent.children = [...new Set(parent.children.map((child) => (child === from ? to : child)))];
    }
  }

  private allNodes(): DashboardNode[] {
    return [...this.nodes.values(), ...this.pendingNodes.values()];
  }

  private link(parent: DashboardNode | undefined, child: DashboardNode): void {
    if (parent && parent !== child && !parent.children.includes(child)) parent.children.push(child);
  }

  private activeAgents(): number {
    return this.allNodes().filter((node) => !isTerminal(node.status)).length;
  }

  private rootTerminalAndChildrenTerminal(): boolean {
    const root = this.rootId === undefined ? undefined : this.nodes.get(this.rootId);
    return (
      root !== undefined &&
      isTerminal(root.status) &&
      this.allNodes().every((node) => isTerminal(node.status))
    );
  }

  private renderNode(
    node: DashboardNode,
    prefix: string,
    isLast: boolean,
    lines: string[],
    root: boolean,
  ): void {
    const suffix = [node.error, node.jsError ? `‼ ${node.jsError}` : undefined]
      .filter(Boolean)
      .join(" — ");
    lines.push(
      `${root ? "" : prefix + (isLast ? "└─ " : "├─ ")}${node.name} — ${node.status}${suffix ? ` — ${suffix}` : ""}`,
    );
    const children = node.children;
    // A completed subtree with no failures is represented by its parent line;
    // aggregate its direct successful siblings below instead of retaining each.
    const visible: DashboardNode[] = [];
    let completed = 0;
    for (const child of children) {
      if (isSuccessfulSubtree(child)) completed++;
      else visible.push(child);
    }
    if (completed > 0) {
      // The aggregate is rendered after active/failing branches so those remain
      // prominent and stable while high-fanout work drains.
      const aggregate = this.aggregateNode(completed);
      visible.push(aggregate);
    }
    const childPrefix = root ? "" : `${prefix}${isLast ? "   " : "│  "}`;
    visible.forEach((child, index) =>
      this.renderNode(child, childPrefix, index === visible.length - 1, lines, false),
    );
  }

  private aggregateNode(count: number): DashboardNode {
    return {
      runId: undefined,
      parentRunId: undefined,
      name: `✓ ${count} completed`,
      status: "completed",
      error: undefined,
      jsError: undefined,
      children: [],
    };
  }
}

interface DashboardNode {
  runId: number | undefined;
  parentRunId: number | undefined;
  name: string;
  status: DashboardStatus;
  error: string | undefined;
  jsError: string | undefined;
  children: DashboardNode[];
}
type DashboardStatus =
  | "new"
  | "waiting for model"
  | "reasoning/model"
  | "running JavaScript"
  | "completed"
  | "failed"
  | "cancelled";

function humanBranchName(handle: RLMChildHandle): string {
  const name = handle.name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return name || "agent";
}

function promptSuffix(prompt: string): string {
  const value = truncate(singleLine(prompt), 64);
  return value ? ` — ${value}` : "";
}

function compactFallback(line: string): string {
  // IDs are implementation details of the [rlm ...] prefix. Never rewrite
  // prompt or error payloads, where a literal #123 may be meaningful.
  return line.replace(
    /^(\[rlm )([^\]]+)(\])/,
    (_, start: string, path: string, end: string) =>
      `${start}${path.replace(/\/run#\d+/g, "/agent").replace(/#\d+/g, "")}${end}`,
  );
}

function colorizeDashboardLine(line: string, color: boolean): string {
  if (!color) return line;
  if (line.includes("failed") || line.includes("cancelled") || line.includes("error"))
    return `\u001b[31m${line}\u001b[39m`;
  if (line.includes("completed")) return `\u001b[32m${line}\u001b[39m`;
  if (line.includes("reasoning/model") || line.includes("running JavaScript"))
    return `\u001b[36m${line}\u001b[39m`;
  return line;
}

function statusForChild(status: RLMChildResult["status"]): DashboardStatus {
  return status === "succeeded"
    ? "completed"
    : status === "cancelled"
      ? "cancelled"
      : status === "failed"
        ? "failed"
        : "waiting for model";
}

function isTerminal(status: DashboardStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isSuccessfulSubtree(node: DashboardNode): boolean {
  return node.status === "completed" && node.children.every((child) => isSuccessfulSubtree(child));
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncateDashboardLine(line: string, columns: number): string {
  // Leave the final terminal column unused: writing into it can trigger an
  // implicit wrap before the explicit newline on some terminals.
  const maximumWidth = Math.max(0, columns - 1);
  const graphemes: Array<{ value: string; width: number }> = [];
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(line)) {
    const segmentWidth = terminalWidth(segment);
    if (width + segmentWidth <= maximumWidth) {
      graphemes.push({ value: segment, width: segmentWidth });
      width += segmentWidth;
      continue;
    }
    while (graphemes.length > 0 && width + 1 > maximumWidth) {
      const removed = graphemes.pop();
      if (removed) width -= removed.width;
    }
    return `${graphemes.map(({ value }) => value).join("")}${maximumWidth > 0 ? "…" : ""}`;
  }
  return line;
}

function terminalWidth(grapheme: string): number {
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  let width = 0;
  for (const value of grapheme) {
    const codePoint = value.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(value) || codePoint === 0x200d || codePoint === 0xfe0f) continue;
    width += isFullWidth(codePoint) ? 2 : 1;
  }
  return width;
}

function isFullWidth(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1ffff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}
