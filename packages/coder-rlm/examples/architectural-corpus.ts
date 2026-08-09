import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { RLM } from "../src/index.ts";

const provider = process.env.RLM_PROVIDER ?? "openai";
const modelId = process.env.RLM_MODEL ?? "gpt-5.4-mini";
const model = builtinModels().getModel(provider, modelId);
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

const rlm = new RLM({ model, context: issues.join("\n\n") });
console.log(
  await rlm.run(
    "Identify the three most common architectural problems in this corpus and give supporting examples.",
  ),
);
