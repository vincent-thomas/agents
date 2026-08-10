import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RLM } from "../src/index.ts";
import { traceRLMEvent } from "./trace.ts";

const DEFAULT_PROMPT_MAX_MODEL_CALLS = 64;
const DEFAULT_PROMPT_JAVASCRIPT_STALL_TIMEOUT_MS = 60_000;

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
const javascriptStallTimeoutMs = positiveIntegerEnv(
  "RLM_JAVASCRIPT_STALL_TIMEOUT_MS",
  DEFAULT_PROMPT_JAVASCRIPT_STALL_TIMEOUT_MS,
);
const modelRequestTimeoutMs = positiveIntegerEnv("RLM_MODEL_REQUEST_TIMEOUT_MS", 300_000);
const runTimeoutMs = positiveIntegerEnv("RLM_RUN_TIMEOUT_MS", 1_800_000);
console.error(
  `[rlm] loading ${provider}/${modelId} (max depth: ${maxDepth ?? 3}, model calls: ${maxModelCalls}, javascript stall timeout: ${javascriptStallTimeoutMs}ms, model timeout: ${modelRequestTimeoutMs}ms, run timeout: ${runTimeoutMs}ms)`,
);
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);

const rlm = new RLM({
  model,
  context: "",
  maxDepth,
  maxModelCalls,
  javascriptStallTimeoutMs,
  modelRequestTimeoutMs,
  runTimeoutMs,
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
