import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RLM, type RLMEvent } from "../src/index.ts";

const DEFAULT_PROMPT_MAX_MODEL_CALLS = 64;

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: bun run --filter @vt-agent/coder-rlm example:prompt "your prompt"');
  process.exit(1);
}

const provider = process.env.RLM_PROVIDER ?? "openai-codex";
const modelId = process.env.RLM_MODEL ?? "gpt-5.4-mini";
const maxDepth =
  process.env.RLM_MAX_DEPTH === undefined ? undefined : Number(process.env.RLM_MAX_DEPTH);
const maxModelCalls =
  process.env.RLM_MAX_MODEL_CALLS === undefined
    ? DEFAULT_PROMPT_MAX_MODEL_CALLS
    : Number(process.env.RLM_MAX_MODEL_CALLS);
console.error(
  `[rlm] loading ${provider}/${modelId} (max depth: ${maxDepth ?? 3}, model calls: ${maxModelCalls})`,
);
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);

const rlm = new RLM({
  model,
  context: "",
  maxDepth,
  maxModelCalls,
  getApiKey: async (providerId) => (await modelRuntime.getAuth(providerId))?.auth.apiKey,
  onEvent: traceEvent,
});

const answer = await rlm.run(prompt);
console.log(answer);

function traceEvent(event: RLMEvent): void {
  const prefix = `[rlm depth=${event.depth}]`;
  if (event.type === "run_start") {
    const kind = event.depth === 0 ? "start" : "recursive call";
    console.error(
      `${prefix} ${kind}: ${event.prompt} (external context: ${event.contextLength} chars)`,
    );
    return;
  }
  if (event.type === "run_end") {
    console.error(`${prefix} complete`);
    return;
  }
  if (event.type === "run_error") {
    console.error(`${prefix} error: ${event.error}`);
    return;
  }
  if (event.event.type === "turn_start") {
    console.error(`${prefix} waiting for model`);
  } else if (event.event.type === "tool_execution_start") {
    const code = event.event.args?.code;
    console.error(`${prefix} javascript:\n${typeof code === "string" ? code : "<missing code>"}`);
  } else if (event.event.type === "tool_execution_end") {
    console.error(
      `${prefix} javascript ${event.event.isError ? "error" : "result"}:\n${toolOutput(event.event.result)}`,
    );
  }
}

function toolOutput(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    return String(result);
  }
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return (
    content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n") || "<no output>"
  );
}
