import { createHash, randomUUID } from "node:crypto";
import { ContextCompiler } from "./context-compiler.ts";
import { evidenceFromObservation } from "./evidence.ts";
import { objectiveCanSatisfy } from "./evaluator.ts";
import { Executor, InvalidActionError } from "./executor.ts";
import type { Planner } from "./planner.ts";
import { validatePlannerDecision } from "./planner.ts";
import type { StateStore } from "./store.ts";
import { transition } from "./transitions.ts";
import type { Action, ActionAttempt, FailureKind, PlannerDecision, RunState } from "./types.ts";

function strategyFingerprint(
  objectiveId: string,
  action: Action,
  stateFingerprint: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([objectiveId, action, stateFingerprint]))
    .digest("hex");
}

function terminal(state: RunState): boolean {
  return Object.values(state.objectives).every((objective) =>
    ["satisfied", "blocked"].includes(objective.status),
  );
}

function advanceHierarchy(state: RunState): RunState {
  if (state.activeObjectiveId) return state;
  let next = state;
  for (const objective of Object.values(next.objectives)) {
    if (
      objective.status === "evaluating" &&
      objective.children.length > 0 &&
      objective.children.every((id) => next.objectives[id]?.status === "satisfied")
    ) {
      next = objectiveCanSatisfy(objective, next)
        ? transition(next, objective.id, "satisfied")
        : transition(next, objective.id, "active");
    }
  }
  const leaf = Object.values(next.objectives).find(
    (objective) =>
      objective.children.length === 0 && ["proposed", "ready"].includes(objective.status),
  );
  if (!leaf) return next;
  if (leaf.status === "proposed") next = transition(next, leaf.id, "ready");
  return transition(next, leaf.id, "active");
}

function failureFor(error: unknown): FailureKind {
  return error instanceof InvalidActionError ? "invalid_action" : "environment_failure";
}

export interface ControllerOptions {
  maxSteps?: number;
  repeatedAttemptLimit?: number;
}

export class Controller {
  private readonly planner: Planner;
  private readonly store: StateStore;
  private readonly compiler: ContextCompiler;
  private readonly options: ControllerOptions;

  constructor(
    planner: Planner,
    store: StateStore,
    compiler = new ContextCompiler(),
    options: ControllerOptions = {},
  ) {
    this.planner = planner;
    this.store = store;
    this.compiler = compiler;
    this.options = options;
  }

  async run(initial: RunState): Promise<RunState> {
    let state = initial;
    const executor = new Executor(state.repoPath, state.contract.allowedEffects);
    const maxSteps = this.options.maxSteps ?? 100;

    for (let step = 0; step < maxSteps; step++) {
      state = advanceHierarchy(state);
      if (terminal(state)) break;
      const objectiveId = state.activeObjectiveId;
      if (!objectiveId) throw new Error("Run has no active objective");
      let decision: PlannerDecision;
      try {
        decision = await this.planner.propose(this.compiler.compile(state, objectiveId));
        validatePlannerDecision(decision);
      } catch (error) {
        state = this.recordFailure(
          state,
          objectiveId,
          { type: "ask_user", question: "invalid" },
          error,
        );
        await this.store.save(state);
        continue;
      }

      if (decision.type === "blocked") {
        state = transition(state, objectiveId, "blocked");
        state = { ...state, blockers: [...state.blockers, decision.reason] };
      } else if (decision.type === "finish") {
        if (decision.objectiveId !== objectiveId)
          throw new Error("Planner may only finish the active objective");
        state = transition(state, objectiveId, "evaluating");
        state = objectiveCanSatisfy(state.objectives[objectiveId], state)
          ? transition(state, objectiveId, "satisfied")
          : transition(state, objectiveId, "active");
      } else if (decision.action.type === "decompose") {
        const childIds = decision.action.objectives.map((draft) => draft.id);
        if (decision.action.objectives.length === 0 || new Set(childIds).size !== childIds.length) {
          state = this.recordFailure(
            state,
            objectiveId,
            decision.action,
            new InvalidActionError("Decomposition requires children with unique IDs"),
          );
        } else {
          const children = Object.fromEntries(
            decision.action.objectives.map((draft) => [
              draft.id,
              {
                id: draft.id,
                parentId: objectiveId,
                intent: draft.intent,
                status: "proposed" as const,
                prerequisites: draft.prerequisites ?? [],
                successCriteria: draft.successCriteria,
                invariants: draft.invariants ?? [],
                children: [],
                evidence: [],
                unresolvedQuestions: [],
              },
            ]),
          );
          if (Object.keys(children).some((id) => state.objectives[id])) {
            state = this.recordFailure(
              state,
              objectiveId,
              decision.action,
              new InvalidActionError("Decomposition reused an objective ID"),
            );
          } else {
            state = transition(state, objectiveId, "evaluating");
            state = {
              ...state,
              objectives: {
                ...state.objectives,
                [objectiveId]: {
                  ...state.objectives[objectiveId],
                  children: Object.keys(children),
                },
                ...children,
              },
            };
            state = advanceHierarchy(state);
          }
        }
      } else if (decision.action.type === "propose_transition") {
        if (decision.action.objectiveId !== objectiveId) {
          state = this.recordFailure(
            state,
            objectiveId,
            decision.action,
            new InvalidActionError("Planner may only transition the active objective"),
          );
        } else {
          try {
            state = transition(state, objectiveId, decision.action.to);
          } catch (error) {
            state = this.recordFailure(state, objectiveId, decision.action, error);
          }
        }
      } else if (decision.action.type === "ask_user") {
        state = transition(state, objectiveId, "blocked");
        state = { ...state, blockers: [...state.blockers, decision.action.question] };
      } else if (["inspect", "search", "command", "edit"].includes(decision.action.type)) {
        const fingerprint = strategyFingerprint(
          objectiveId,
          decision.action,
          state.repositoryFingerprint,
        );
        const repetitions = state.attempts.filter(
          (attempt) => attempt.strategyFingerprint === fingerprint && attempt.failure,
        ).length;
        if (repetitions >= (this.options.repeatedAttemptLimit ?? 2)) {
          state = this.recordFailure(
            state,
            objectiveId,
            decision.action,
            new Error("Repeated attempt"),
            "repeated_attempt",
          );
          state = transition(state, objectiveId, "blocked");
        } else {
          try {
            const observation = await executor.execute(decision.action);
            const evidence = evidenceFromObservation(objectiveId, decision.action, observation);
            const failure: FailureKind | undefined = observation.timedOut
              ? "timeout"
              : observation.unexpectedFiles.length
                ? "unexpected_effect"
                : observation.exitCode !== undefined && observation.exitCode !== 0
                  ? "command_failure"
                  : undefined;
            const attempt: ActionAttempt = {
              id: observation.actionId,
              objectiveId,
              action: decision.action,
              strategyFingerprint: fingerprint,
              observation,
              failure,
            };
            state = {
              ...state,
              repositoryFingerprint: observation.repositoryFingerprintAfter,
              evidence: [...state.evidence, ...evidence],
              attempts: [...state.attempts, attempt],
              objectives: {
                ...state.objectives,
                [objectiveId]: {
                  ...state.objectives[objectiveId],
                  evidence: [
                    ...state.objectives[objectiveId].evidence,
                    ...evidence.map((item) => item.id),
                  ],
                },
              },
            };
            if (failure === "unexpected_effect") state = transition(state, objectiveId, "blocked");
          } catch (error) {
            state = this.recordFailure(state, objectiveId, decision.action, error);
          }
        }
      } else {
        state = this.recordFailure(
          state,
          objectiveId,
          decision.action,
          new InvalidActionError("Non-executable action"),
        );
      }

      state = { ...state, updatedAt: new Date().toISOString() };
      await this.store.save(state);
    }
    return state;
  }

  private recordFailure(
    state: RunState,
    objectiveId: string,
    action: Action,
    error: unknown,
    kind = failureFor(error),
  ): RunState {
    const id = randomUUID();
    return {
      ...state,
      attempts: [
        ...state.attempts,
        {
          id,
          objectiveId,
          action,
          strategyFingerprint: strategyFingerprint(
            objectiveId,
            action,
            state.repositoryFingerprint,
          ),
          failure: kind,
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
