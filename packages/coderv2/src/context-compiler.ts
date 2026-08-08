import type { DecisionContext, RunState } from "./types.ts";

export interface ContextCompilerOptions {
  maxEvidence?: number;
  maxAttempts?: number;
  maxOutputCharacters?: number;
}

export class ContextCompiler {
  private readonly options: ContextCompilerOptions;

  constructor(options: ContextCompilerOptions = {}) {
    this.options = options;
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
            : item,
        ),
      recentAttempts: state.attempts
        .filter((attempt) => attempt.objectiveId === objectiveId)
        .slice(-(this.options.maxAttempts ?? 5)),
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
