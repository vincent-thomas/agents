import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RLM, type RLMEvent } from "../src/index.ts";
import { buildAutonomousEvaluationCorpus } from "./autonomous-corpus.ts";
import { createRLMEventTracer } from "./trace.ts";

const corpus = buildAutonomousEvaluationCorpus();
const provider = process.env.RLM_PROVIDER ?? "openai-codex";
const modelId = process.env.RLM_MODEL ?? "gpt-5.6-luna";
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);

const metrics = {
  modelCalls: 0,
  javascriptCalls: 0,
  recursiveCalls: 0,
  maxDepth: 0,
  delegatedContextSizes: [] as number[],
};
const startedAt = performance.now();
const trace = createRLMEventTracer({ maxModelCalls: 32, maxDepth: 3 });
const rlm = new RLM({
  model,
  context: corpus.context,
  maxDepth: 3,
  maxModelCalls: 32,
  getApiKey: async (providerId) => (await modelRuntime.getAuth(providerId))?.auth.apiKey,
  onEvent: traceAndMeasure,
});

const answer = await rlm.run(
  "Across these engineering incident reports, identify the three most prevalent underlying architectural failure modes. Explain why each one recurs and cite at least two report IDs as evidence.",
);
const elapsedSeconds = (performance.now() - startedAt) / 1_000;

console.log(answer);
console.error("\nAutonomous RLM evaluation");
console.error(`  recursion chosen: ${metrics.recursiveCalls > 0 ? "yes" : "no"}`);
console.error(`  recursive calls: ${metrics.recursiveCalls}`);
console.error(`  maximum depth: ${metrics.maxDepth}`);
console.error(`  model calls: ${metrics.modelCalls}`);
console.error(`  JavaScript calls: ${metrics.javascriptCalls}`);
console.error(
  `  delegated context sizes: ${metrics.delegatedContextSizes.length > 0 ? metrics.delegatedContextSizes.join(", ") : "none"}`,
);
console.error(`  elapsed: ${elapsedSeconds.toFixed(1)}s`);
console.error(
  `  external context: ${corpus.context.length} chars across ${corpus.reportCount} reports`,
);
console.error(`  multi-cause reports: ${corpus.multiCauseReportCount}`);
console.error(`  expected top themes: ${corpus.expectedTopThemes.join("; ")}`);

function traceAndMeasure(event: RLMEvent): void {
  metrics.maxDepth = Math.max(metrics.maxDepth, event.depth);
  if (event.type === "run_start" && event.depth > 0) {
    metrics.recursiveCalls++;
    metrics.delegatedContextSizes.push(event.contextLength);
  }
  if (event.type === "model_start") metrics.modelCalls++;
  if (event.type === "javascript_start") metrics.javascriptCalls++;
  trace(event);
}
