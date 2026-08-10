import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RLM } from "../src/index.ts";
import { traceRLMEvent } from "./trace.ts";

const DEFAULT_PROMPT_MAX_MODEL_CALLS = 64;

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: bun run --filter @vt-agent/coder-rlm example:prompt "your prompt"');
  process.exit(1);
}

const provider = process.env.RLM_PROVIDER ?? "openai-codex";
const modelId = process.env.RLM_MODEL ?? "gpt-5.6-luna";
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
  onEvent: traceRLMEvent,
});

const answer = await rlm.run(prompt);
console.log(answer);
