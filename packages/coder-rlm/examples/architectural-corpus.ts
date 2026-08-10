import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RLM, type RLMEvent } from "../src/index.ts";

const provider = process.env.RLM_PROVIDER ?? "openai-codex";
const modelId = process.env.RLM_MODEL ?? "gpt-5.6-luna";
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);

const issueTemplates = [
  "Authentication logic is duplicated across the API and worker services.",
  "The request timeout is configured independently in three packages.",
  "Domain rules leak into HTTP handlers, making them hard to test.",
  "Background jobs have no idempotency key and are occasionally processed twice.",
];
const issues = Array.from(
  { length: 2_000 },
  (_, index) => `Issue ${index + 1}: ${issueTemplates[index % issueTemplates.length]}`,
);

const rlm = new RLM({
  model,
  context: issues.join("\n\n"),
  getApiKey: async (providerId) => (await modelRuntime.getAuth(providerId))?.auth.apiKey,
  onEvent: traceEvent,
});
console.log(
  await rlm.run(
    "Identify the three most common architectural problems in this corpus and give supporting examples.",
  ),
);

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
  if (event.event.type === "tool_execution_start") {
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
