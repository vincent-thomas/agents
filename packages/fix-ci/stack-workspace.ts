/** Host-owned workspace state used to guard stack traversal and persistence. */
export interface WorkspaceControllerSnapshot {
  activeBranch: string | null;
  branches: string[];
  baseBranch: string | null;
}

export interface WorkspaceControllerClaim {
  activeBranch: string;
  branches: string[];
  baseBranch: string;
}

/**
 * The fix-ci package deliberately does not know how the host stores workspace
 * ownership. The controller validates read-only, then claims only after the
 * checkout has been verified.
 *
 * `claim` is atomic: a rejected call means that it made no durable registry
 * change. Callers still restore and verify the prior snapshot during cleanup,
 * because the checkout itself may already have changed the workspace signal.
 */
export interface WorkspaceController {
  snapshot(cwd: string): WorkspaceControllerSnapshot | Promise<WorkspaceControllerSnapshot>;
  validate(cwd: string, claim: WorkspaceControllerClaim): void | Promise<void>;
  claim(cwd: string, claim: WorkspaceControllerClaim): void | Promise<void>;
  /** Restore an earlier ownership snapshot; callers invoke this signal-free. */
  restore(cwd: string, snapshot: WorkspaceControllerSnapshot): void | Promise<void>;
}
