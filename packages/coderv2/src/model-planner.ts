import type { AssistantMessage, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import { validatePlannerDecision, type Planner } from "./planner.ts";
import type { DecisionContext, PlannerDecision } from "./types.ts";

const SYSTEM_PROMPT = `You are the planner inside an evidence-gated coding harness.

Choose the single best next decision for the active objective. The harness, not you, owns trusted state and decides whether completion is valid. The evaluations field reports the deterministic status of every predicate. Do not assume that a successful command proves more than it observed. Prefer actions that produce mechanical evidence required by currently unknown predicates.

Return exactly one JSON object and no prose or Markdown. It must have one of these shapes:

{"type":"action","action":{"type":"inspect","paths":["relative/path"]},"rationale":"optional"}
{"type":"action","action":{"type":"search","query":"pattern","paths":["optional/path"]},"rationale":"optional"}
{"type":"action","action":{"type":"command","command":"command","cwd":"optional/relative/path","timeoutMs":120000,"test":false},"rationale":"optional"}
{"type":"action","action":{"type":"edit","patch":"complete unified diff"},"rationale":"optional"}
{"type":"action","action":{"type":"decompose","objectives":[{"id":"unique-id","intent":"...","successCriteria":[],"invariants":[]}]},"rationale":"optional"}
{"type":"finish","objectiveId":"active-objective-id","evidenceIds":["evidence-id"]}
{"type":"blocked","reason":"why progress is impossible","question":"optional user question"}

Paths must stay inside the repository. Edits must be complete unified diffs accepted by git apply. Never invent evidence IDs. Do not repeat a failed action against an unchanged state. A finish proposal is appropriate only when the context contains current evidence for every success criterion and invariant.`;

function responseText(response: AssistantMessage): string {
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `Model stopped with ${response.stopReason}`);
  }
  return response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export function parsePlannerDecision(text: string): PlannerDecision {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("Model response did not contain a JSON object");
  let decision: unknown;
  try {
    decision = JSON.parse(unfenced.slice(start, end + 1));
  } catch (error) {
    throw new Error(
      `Model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validatePlannerDecision(decision);
  return decision;
}

export interface ModelPlannerOptions {
  reasoningEffort?: ThinkingLevel;
  maxTokens?: number;
}

export class ModelPlanner implements Planner {
  private readonly models: Models;
  private readonly model: Model<any>;
  private readonly options: ModelPlannerOptions;

  constructor(models: Models, model: Model<any>, options: ModelPlannerOptions = {}) {
    this.models = models;
    this.model = model;
    this.options = options;
  }

  async propose(input: DecisionContext): Promise<PlannerDecision> {
    const response = await this.models.complete(
      this.model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: JSON.stringify(input) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        reasoningEffort: this.options.reasoningEffort ?? "medium",
        maxTokens: this.options.maxTokens ?? 8_000,
      },
    );
    return parsePlannerDecision(responseText(response));
  }
}
