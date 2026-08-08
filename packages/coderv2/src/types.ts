export type ObjectiveStatus =
  | "proposed"
  | "ready"
  | "active"
  | "evaluating"
  | "satisfied"
  | "blocked"
  | "invalidated";

export type EvidenceRequirement =
  | { type: "command_exit"; command: string; exitCode: number }
  | { type: "test_passed"; command: string }
  | { type: "path_changed"; path: string }
  | { type: "path_unchanged"; path: string }
  | { type: "source_matches"; path: string; pattern: string; absent?: boolean }
  | { type: "user_confirmation"; key: string }
  | { type: "judgment"; key: string }
  | { type: "unsupported"; name: string };

export interface Predicate {
  id: string;
  description: string;
  requirement: EvidenceRequirement;
}

export type PredicateResult =
  | { status: "satisfied"; evidenceIds: string[] }
  | { status: "violated"; evidenceIds: string[] }
  | { status: "unknown"; missing: EvidenceRequirement[] };

export interface EffectBoundary {
  path: string;
}

export interface TaskContract {
  intent: string;
  successCriteria: Predicate[];
  invariants: Predicate[];
  allowedEffects: EffectBoundary[];
  nonGoals?: string[];
}

export interface Objective {
  id: string;
  parentId?: string;
  intent: string;
  status: ObjectiveStatus;
  prerequisites: Predicate[];
  successCriteria: Predicate[];
  invariants: Predicate[];
  children: string[];
  evidence: string[];
  unresolvedQuestions: string[];
}

export interface EvidenceBase {
  id: string;
  createdAt: string;
  objectiveId: string;
  repositoryFingerprint: string;
  actionId: string;
}

export type Evidence =
  | (EvidenceBase & {
      type: "command" | "test";
      command: string;
      cwd: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
      timedOut: boolean;
    })
  | (EvidenceBase & {
      type: "source";
      path: string;
      content: string;
      contentHash: string;
    })
  | (EvidenceBase & {
      type: "diff";
      changedFiles: string[];
      unexpectedFiles: string[];
      beforeFingerprint: string;
    })
  | (EvidenceBase & { type: "user"; key: string; confirmed: boolean })
  | (EvidenceBase & { type: "judgment"; key: string; conclusion: string });

export interface Claim {
  id: string;
  statement: string;
  status: "proposed" | "supported" | "contradicted" | "superseded";
  evidenceIds: string[];
}

export type Action =
  | { type: "inspect"; paths: string[] }
  | { type: "search"; query: string; paths?: string[] }
  | { type: "command"; command: string; cwd?: string; timeoutMs?: number; test?: boolean }
  | { type: "edit"; patch: string }
  | { type: "decompose"; objectives: ObjectiveDraft[] }
  | {
      type: "propose_transition";
      objectiveId: string;
      to: ObjectiveStatus;
      evidenceIds: string[];
    }
  | { type: "ask_user"; question: string };

export interface ObjectiveDraft {
  id: string;
  intent: string;
  prerequisites?: Predicate[];
  successCriteria: Predicate[];
  invariants?: Predicate[];
}

export interface FileSnapshot {
  path: string;
  hash: string;
}

export interface ActionObservation {
  actionId: string;
  expectedEffect?: string;
  startedAt: string;
  finishedAt: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  filesBefore: FileSnapshot[];
  filesAfter: FileSnapshot[];
  changedFiles: string[];
  unexpectedFiles: string[];
  repositoryFingerprintBefore: string;
  repositoryFingerprintAfter: string;
}

export type FailureKind =
  | "invalid_action"
  | "command_failure"
  | "timeout"
  | "unexpected_effect"
  | "policy_violation"
  | "environment_failure"
  | "missing_information"
  | "repeated_attempt";

export interface ActionAttempt {
  id: string;
  objectiveId: string;
  action: Action;
  strategyFingerprint: string;
  observation?: ActionObservation;
  failure?: FailureKind;
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  repoPath: string;
  repositoryFingerprint: string;
  contract: TaskContract;
  objectives: Record<string, Objective>;
  activeObjectiveId?: string;
  claims: Claim[];
  evidence: Evidence[];
  attempts: ActionAttempt[];
  blockers: string[];
  createdAt: string;
  updatedAt: string;
}

export type PlannerDecision =
  | { type: "action"; action: Action; rationale?: string }
  | { type: "finish"; objectiveId: string; evidenceIds: string[] }
  | { type: "blocked"; reason: string; question?: string };

export interface DecisionContext {
  intent: string;
  objective: Objective;
  contract: Pick<TaskContract, "allowedEffects" | "nonGoals">;
  claims: Claim[];
  evidence: Evidence[];
  recentAttempts: ActionAttempt[];
  repositoryFingerprint: string;
  availableActions: Action["type"][];
}
