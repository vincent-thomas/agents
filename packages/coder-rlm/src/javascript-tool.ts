import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JavaScriptRuntime } from "./runtime.ts";

const parameters = Type.Object({
  code: Type.String({
    description:
      "JavaScript to execute. Top-level await is supported and declarations persist across calls.",
  }),
});

export function createJavascriptTool(runtime: JavaScriptRuntime): AgentTool<typeof parameters> {
  return {
    name: "javascript",
    label: "JavaScript",
    description:
      "Execute JavaScript in a persistent, capability-constrained runtime. Capabilities are exposed under ctx: ctx.context, ctx.llm(), ctx.console.log/error(), and the read-only ctx.fs.read(selector).",
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, { code }, signal) {
      const result = await runtime.execute(code, signal);
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
