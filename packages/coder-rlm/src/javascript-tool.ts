import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JavaScriptExecutionResult, JavaScriptRuntimeLike } from "./runtime.ts";

const parameters = Type.Object({
  code: Type.String({
    description:
      "JavaScript to execute. Top-level await is supported and declarations persist across calls.",
  }),
});

export interface JavascriptToolOptions {
  onFatalError?: (error: unknown) => void;
  customContext?: boolean;
}

export function createJavascriptTool(
  runtime: JavaScriptRuntimeLike,
  options: JavascriptToolOptions = {},
): AgentTool<typeof parameters> {
  return {
    name: "javascript",
    label: "JavaScript",
    description: options.customContext
      ? "Execute JavaScript in a persistent runtime over the configured capabilities in the exact live host ctx object described in the system instructions. This mode is unsafe and is not a security boundary."
      : "Execute JavaScript in a persistent, capability-constrained runtime. Capabilities are exposed under ctx: ctx.context, ctx.rlm.spawn/waitAll/result/cancel() (spawn tiers: fast, balanced, deep), ctx.console.log/error(), and the read-only ctx.fs.read(selector).",
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, { code }, signal) {
      let result: JavaScriptExecutionResult;
      try {
        result = await runtime.execute(code, signal);
      } catch (error) {
        if (!signal?.aborted) options.onFatalError?.(error);
        throw error;
      }
      if (result.error) {
        const output =
          result.output === "JavaScript completed with no output." ? "" : result.output;
        const suffix = output ? `\n\nConsole output:\n${output}` : "";
        throw new Error(`${result.error.name}: ${result.error.message}${suffix}`);
      }
      return {
        content: [{ type: "text", text: result.output }],
        details: {},
      };
    },
  };
}
