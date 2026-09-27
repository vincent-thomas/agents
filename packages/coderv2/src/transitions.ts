import type { ObjectiveStatus, RunState } from "./types.ts";
import { evaluatePredicates, objectiveCanSatisfy } from "./evaluator.ts";

const LEGAL: Record<ObjectiveStatus, ObjectiveStatus[]> = {
  proposed: ["ready"],
  ready: ["active"],
  active: ["evaluating", "blocked"],
  evaluating: ["satisfied", "active", "blocked"],
  satisfied: ["invalidated"],
  blocked: ["ready"],
  invalidated: ["ready"],
};

export function transition(state: RunState, objectiveId: string, to: ObjectiveStatus): RunState {
  const objective = state.objectives[objectiveId];
  if (!objective) throw new Error(`Unknown objective: ${objectiveId}`);
  if (!LEGAL[objective.status].includes(to)) {
    throw new Error(`Illegal objective transition: ${objective.status} -> ${to}`);
  }
  if (
    objective.status === "proposed" &&
    to === "ready" &&
    !evaluatePredicates(objective.prerequisites, state).every(
      (result) => result.status === "satisfied",
    )
  ) {
    throw new Error("Objective prerequisites are not satisfied");
  }
  if (
    objective.status === "evaluating" &&
    to === "satisfied" &&
    !objectiveCanSatisfy(objective, state)
  ) {
    throw new Error("Objective cannot be satisfied without current supporting evidence");
  }
  if (to === "active") {
    const other = Object.values(state.objectives).find(
      (candidate) => candidate.id !== objectiveId && candidate.status === "active",
    );
    if (other) throw new Error(`Objective ${other.id} is already active`);
    if (objective.children.some((id) => state.objectives[id]?.status !== "satisfied")) {
      throw new Error("Only objectives without unfinished children may become active");
    }
  }

  return {
    ...state,
    activeObjectiveId:
      to === "active"
        ? objectiveId
        : state.activeObjectiveId === objectiveId
          ? undefined
          : state.activeObjectiveId,
    objectives: { ...state.objectives, [objectiveId]: { ...objective, status: to } },
    updatedAt: new Date().toISOString(),
  };
}
