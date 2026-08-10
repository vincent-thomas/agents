import type { RLMEvent } from "../src/index.ts";

export function traceRLMEvent(
  event: RLMEvent,
  outputLimit?: number,
  write: (message: string) => void = console.error,
): void {
  write(formatRLMEvent(event, outputLimit));
}

export function formatRLMEvent(event: RLMEvent, outputLimit?: number): string {
  const prefix = `[rlm depth=${event.depth}]`;
  switch (event.type) {
    case "run_start": {
      const kind = event.depth === 0 ? "start" : "recursive call";
      return `${prefix} ${kind}: ${event.prompt} (external context: ${event.contextLength} chars)`;
    }
    case "model_start":
      return `${prefix} waiting for model (call ${event.modelCall})`;
    case "model_end":
      return `${prefix} model complete (${event.stopReason})`;
    case "javascript_start":
      return `${prefix} javascript:\n${event.code}`;
    case "javascript_end": {
      const output = event.output || "<no output>";
      const renderedOutput = outputLimit === undefined ? output : truncate(output, outputLimit);
      return `${prefix} javascript ${event.isError ? "error" : "result"}:\n${renderedOutput}`;
    }
    case "run_end":
      return `${prefix} complete`;
    case "run_error":
      return `${prefix} error: ${event.error}`;
    default: {
      const exhaustiveEvent: never = event;
      return `${prefix} unknown event: ${String(exhaustiveEvent)}`;
    }
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n... ${value.length - maximum} chars omitted`;
}
