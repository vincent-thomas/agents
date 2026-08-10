import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RLM } from "../src/index.ts";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: bun run --filter @vt-agent/coder-rlm example:prompt "your prompt"');
  process.exit(1);
}

const provider = process.env.RLM_PROVIDER ?? "openai-codex";
const modelId = process.env.RLM_MODEL ?? "gpt-5.4-mini";
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);

const rlm = new RLM({
  model,
  context: "",
  getApiKey: async (providerId) => (await modelRuntime.getAuth(providerId))?.auth.apiKey,
});

console.log(await rlm.run(prompt));
