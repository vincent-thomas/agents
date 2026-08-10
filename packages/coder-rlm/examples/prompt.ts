import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RLM } from "../src/index.ts";
import { traceRLMEvent } from "./trace.ts";

const DEFAULT_PROMPT_MAX_MODEL_CALLS = 64;
// Five minutes gives several concurrent high-thinking delegates time to finish while
// retaining a hard bound for a single JavaScript turn.
const DEFAULT_PROMPT_EXECUTION_TIMEOUT_MS = 300_000;

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: bun run --filter @vt-agent/coder-rlm example:prompt "your prompt"');
  process.exit(1);
}

const provider = process.env.RLM_PROVIDER ?? "openai-codex";
const modelId = process.env.RLM_MODEL ?? "gpt-5.6-luna";
const maxDepth =
  process.env.RLM_MAX_DEPTH === undefined ? undefined : Number(process.env.RLM_MAX_DEPTH);
const maxModelCalls = positiveIntegerEnv("RLM_MAX_MODEL_CALLS", DEFAULT_PROMPT_MAX_MODEL_CALLS);
const executionTimeoutMs = positiveIntegerEnv(
  "RLM_EXECUTION_TIMEOUT_MS",
  DEFAULT_PROMPT_EXECUTION_TIMEOUT_MS,
);
console.error(
  `[rlm] loading ${provider}/${modelId} (max depth: ${maxDepth ?? 3}, model calls: ${maxModelCalls}, execution timeout: ${executionTimeoutMs}ms)`,
);
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);

const rlm = new RLM({
  model,
  context: "",
  maxDepth,
  maxModelCalls,
  executionTimeoutMs,
  getApiKey: async (providerId) => (await modelRuntime.getAuth(providerId))?.auth.apiKey,
  onEvent: traceRLMEvent,
});

const answer = await rlm.run(prompt);
console.log(answer);

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
