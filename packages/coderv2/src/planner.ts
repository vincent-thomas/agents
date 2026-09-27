import type { DecisionContext, PlannerDecision } from "./types.ts";

export interface Planner {
  propose(input: DecisionContext): Promise<PlannerDecision>;
}

export class ScriptedPlanner implements Planner {
  private offset = 0;
  private readonly decisions: PlannerDecision[];

  constructor(decisions: PlannerDecision[]) {
    this.decisions = decisions;
  }

  async propose(_input: DecisionContext): Promise<PlannerDecision> {
    const decision = this.decisions[this.offset++];
    if (!decision) return { type: "blocked", reason: "Scripted planner exhausted" };
    return decision;
  }
}

export function validatePlannerDecision(value: unknown): asserts value is PlannerDecision {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Planner returned a non-object decision");
  }
  const decision = value as Record<string, unknown>;
  if (!["action", "finish", "blocked"].includes(String(decision.type))) {
    throw new Error(`Planner returned unknown decision type: ${String(decision.type)}`);
  }
  if (decision.type === "action") {
    const action = decision.action as Record<string, unknown> | undefined;
    if (!action || typeof action.type !== "string") throw new Error("Planner action is malformed");
    switch (action.type) {
      case "inspect":
        if (!Array.isArray(action.paths) || !action.paths.every((path) => typeof path === "string"))
          throw new Error("Inspect action is malformed");
        break;
      case "search":
        if (typeof action.query !== "string") throw new Error("Search action is malformed");
        break;
      case "command":
        if (typeof action.command !== "string" || !action.command.trim())
          throw new Error("Command action is malformed");
        break;
      case "edit":
        if (typeof action.patch !== "string" || !action.patch.trim())
          throw new Error("Edit action is malformed");
        break;
      case "decompose":
      case "propose_transition":
      case "ask_user":
        break;
      default:
        throw new Error(`Unknown action type: ${String(action.type)}`);
    }
  }
}
