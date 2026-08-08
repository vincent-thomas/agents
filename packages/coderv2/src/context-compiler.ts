import type { DecisionContext, RunState } from "./types.ts";
import { evaluateRequirement } from "./evaluator.ts";

export interface ContextCompilerOptions {
  maxEvidence?: number;
  maxAttempts?: number;
  maxOutputCharacters?: number;
}

export class ContextCompiler {
  private readonly options: ContextCompilerOptions;

  constructor(options: ContextCompilerOptions = {}) {
    this.options = { maxOutputCharacters: 60_000, ...options };
  }

  compile(state: RunState, objectiveId: string): DecisionContext {
    const objective = state.objectives[objectiveId];
    if (!objective) throw new Error(`Unknown objective: ${objectiveId}`);
    const evidenceIds = new Set(objective.evidence);
    const context: DecisionContext = {
      intent: state.contract.intent,
      objective,
      contract: {
        allowedEffects: state.contract.allowedEffects,
        nonGoals: state.contract.nonGoals,
      },
      claims: state.claims.filter((claim) => claim.evidenceIds.some((id) => evidenceIds.has(id))),
      evidence: state.evidence
        .filter((item) => item.objectiveId === objectiveId)
        .slice(-(this.options.maxEvidence ?? 12))
        .map((item) =>
          item.type === "command" || item.type === "test"
            ? { ...item, stdout: item.stdout.slice(-2_000), stderr: item.stderr.slice(-2_000) }
            : item.type === "source"
              ? { ...item, content: item.content.slice(0, 8_000) }
              : item,
        ),
      evaluations: {
        successCriteria: Object.fromEntries(
          objective.successCriteria.map((predicate) => [
            predicate.id,
            evaluateRequirement(predicate.requirement, state),
          ]),
        ),
        invariants: Object.fromEntries(
          objective.invariants.map((predicate) => [
            predicate.id,
            evaluateRequirement(predicate.requirement, state),
          ]),
        ),
      },
      recentAttempts: state.attempts
        .filter((attempt) => attempt.objectiveId === objectiveId)
        .slice(-(this.options.maxAttempts ?? 5))
        .map((attempt) => ({
          ...attempt,
          observation: attempt.observation
            ? {
                ...attempt.observation,
                stdout: attempt.observation.stdout?.slice(-2_000),
                stderr: attempt.observation.stderr?.slice(-2_000),
                filesBefore: [],
                filesAfter: [],
              }
            : undefined,
        })),
      repositoryFingerprint: state.repositoryFingerprint,
      availableActions: [
        "inspect",
        "search",
        "command",
        "edit",
        "decompose",
        "propose_transition",
        "ask_user",
      ],
    };
    const limit = this.options.maxOutputCharacters;
    if (limit && JSON.stringify(context).length > limit) {
      context.evidence = [];
      context.recentAttempts = [];
      context.claims = [];
    }
    if (limit && JSON.stringify(context).length > limit) {
      throw new Error(`Essential decision context exceeds configured bound of ${limit} characters`);
    }
    return context;
  }
}
