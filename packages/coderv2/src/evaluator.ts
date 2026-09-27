import type {
  Evidence,
  EvidenceRequirement,
  Objective,
  Predicate,
  PredicateResult,
  RunState,
} from "./types.ts";

function current(evidence: Evidence, state: RunState): boolean {
  return evidence.type === "user" || evidence.repositoryFingerprint === state.repositoryFingerprint;
}

function matchingEvidence(requirement: EvidenceRequirement, state: RunState): Evidence[] {
  return state.evidence.filter((item) => {
    if (!current(item, state)) return false;
    switch (requirement.type) {
      case "command_exit":
        return item.type === "command" && item.command === requirement.command;
      case "test_passed":
        return item.type === "test" && item.command === requirement.command;
      case "path_changed":
      case "path_unchanged":
        return item.type === "diff";
      case "source_matches":
        return item.type === "source" && item.path === requirement.path;
      case "user_confirmation":
        return item.type === "user" && item.key === requirement.key;
      case "judgment":
        return item.type === "judgment" && item.key === requirement.key;
      case "unsupported":
        return false;
    }
  });
}

export function evaluateRequirement(
  requirement: EvidenceRequirement,
  state: RunState,
): PredicateResult {
  const matches = matchingEvidence(requirement, state);
  const ids = matches.map((item) => item.id);
  if (requirement.type === "unsupported" || matches.length === 0) {
    return { status: "unknown", missing: [requirement] };
  }

  switch (requirement.type) {
    case "command_exit": {
      const latest = matches.at(-1)!;
      return latest.type === "command" && latest.exitCode === requirement.exitCode
        ? { status: "satisfied", evidenceIds: [latest.id] }
        : { status: "violated", evidenceIds: [latest.id] };
    }
    case "test_passed": {
      const latest = matches.at(-1)!;
      return latest.type === "test" && latest.exitCode === 0 && !latest.timedOut
        ? { status: "satisfied", evidenceIds: [latest.id] }
        : { status: "violated", evidenceIds: [latest.id] };
    }
    case "path_changed":
      return matches.some(
        (item) => item.type === "diff" && item.changedFiles.includes(requirement.path),
      )
        ? { status: "satisfied", evidenceIds: ids }
        : { status: "violated", evidenceIds: ids };
    case "path_unchanged":
      return matches.some(
        (item) => item.type === "diff" && item.changedFiles.includes(requirement.path),
      )
        ? { status: "violated", evidenceIds: ids }
        : { status: "satisfied", evidenceIds: ids };
    case "source_matches": {
      const item = matches.at(-1)!;
      if (item.type !== "source") return { status: "unknown", missing: [requirement] };
      let found = false;
      try {
        found = new RegExp(requirement.pattern).test(item.content);
      } catch {
        found = item.content.includes(requirement.pattern);
      }
      return found !== Boolean(requirement.absent)
        ? { status: "satisfied", evidenceIds: [item.id] }
        : { status: "violated", evidenceIds: [item.id] };
    }
    case "user_confirmation": {
      const item = matches.at(-1)!;
      return item.type === "user" && item.confirmed
        ? { status: "satisfied", evidenceIds: [item.id] }
        : { status: "violated", evidenceIds: [item.id] };
    }
    case "judgment":
      return { status: "satisfied", evidenceIds: [matches.at(-1)!.id] };
    case "unsupported":
      return { status: "unknown", missing: [requirement] };
  }
}

export function evaluatePredicates(predicates: Predicate[], state: RunState): PredicateResult[] {
  return predicates.map((predicate) => evaluateRequirement(predicate.requirement, state));
}

export function objectiveCanSatisfy(objective: Objective, state: RunState): boolean {
  const success = evaluatePredicates(objective.successCriteria, state);
  const invariants = evaluatePredicates(objective.invariants, state);
  return (
    success.every((result) => result.status === "satisfied") &&
    invariants.every((result) => result.status === "satisfied")
  );
}

export function reconcileObjective(state: RunState, objectiveId: string): RunState {
  const objective = state.objectives[objectiveId];
  if (!objective) throw new Error(`Unknown objective: ${objectiveId}`);
  if (objective.status === "satisfied" && !objectiveCanSatisfy(objective, state)) {
    return {
      ...state,
      activeObjectiveId:
        state.activeObjectiveId === objectiveId ? undefined : state.activeObjectiveId,
      objectives: {
        ...state.objectives,
        [objectiveId]: { ...objective, status: "invalidated" },
      },
      updatedAt: new Date().toISOString(),
    };
  }
  return state;
}
