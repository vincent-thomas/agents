import { currentBranch, isWorktreeDirty } from "./git-utils.ts";
import type { GhStackProbeResult, GhStackView, WorkspaceBranchRestorer } from "./github-stack.ts";
import type {
  WorkspaceController,
  WorkspaceControllerClaim,
  WorkspaceControllerSnapshot,
} from "./stack-workspace.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exactLocalStack(view: GhStackView, claim: WorkspaceControllerClaim): boolean {
  return (
    JSON.stringify(view.branches.map((branch) => branch.name)) === JSON.stringify(claim.branches) &&
    (view.trunk ?? view.base) === claim.baseBranch
  );
}

/** Verify the refreshed enriched view before changing workspace ownership. */
export async function verifyRefreshedStack(
  actualBranch: string | null,
  refreshed: GhStackProbeResult,
  claim: WorkspaceControllerClaim,
  isWorkingTreeClean: () => Promise<boolean>,
): Promise<boolean> {
  const refreshedCurrentMarkers =
    refreshed.view?.branches.filter((branch) => branch.isCurrent) ?? [];
  return (
    actualBranch === claim.activeBranch &&
    (await isWorkingTreeClean()) &&
    refreshed.status === "stacked" &&
    refreshed.view !== undefined &&
    refreshed.view.currentBranch === claim.activeBranch &&
    refreshedCurrentMarkers.length === 1 &&
    refreshedCurrentMarkers[0].name === claim.activeBranch &&
    exactLocalStack(refreshed.view, claim)
  );
}

export async function restoreBranchSignalFree(
  cwd: string,
  originalBranch: string,
  restore: WorkspaceBranchRestorer,
): Promise<{ text: string; details: Record<string, unknown> }> {
  let before: string | null;
  try {
    before = await currentBranch(cwd);
  } catch (error: unknown) {
    return {
      text: `Rollback could not inspect the current branch: ${errorMessage(error)}.`,
      details: {
        rolledBack: false,
        rollbackAttempted: false,
        rollbackInspectionFailed: true,
        rollbackError: errorMessage(error),
      },
    };
  }

  if (before === originalBranch) {
    try {
      const workingTreeClean = !(await isWorktreeDirty(cwd));
      return {
        text: workingTreeClean
          ? `The original branch \`${originalBranch}\` was already active; rollback was not needed.`
          : `The original branch \`${originalBranch}\` was active, but rollback left a dirty working tree.`,
        details: {
          rolledBack: workingTreeClean,
          rollbackBranch: originalBranch,
          rollbackAttempted: false,
          workingTreeClean,
        },
      };
    } catch (error: unknown) {
      return {
        text: `Rollback could not inspect working-tree status: ${errorMessage(error)}.`,
        details: {
          rolledBack: false,
          rollbackAttempted: false,
          rollbackInspectionFailed: true,
          rollbackBranch: originalBranch,
          rollbackError: errorMessage(error),
        },
      };
    }
  }

  let result: Awaited<ReturnType<WorkspaceBranchRestorer>>;
  try {
    // Deliberately omit the caller's signal: cleanup must run after cancellation.
    result = await restore(cwd, originalBranch, undefined);
  } catch (error: unknown) {
    return {
      text: `Rollback failed while restoring branch \`${originalBranch}\`: ${errorMessage(error)}.`,
      details: {
        rolledBack: false,
        rollbackAttempted: true,
        rollbackBranch: before,
        rollbackRestoreFailed: true,
        rollbackError: errorMessage(error),
      },
    };
  }

  let after: string | null;
  let workingTreeClean: boolean;
  try {
    after = await currentBranch(cwd);
    workingTreeClean = !(await isWorktreeDirty(cwd));
  } catch (error: unknown) {
    return {
      text: `Rollback completed a restore command, but verification failed: ${errorMessage(error)}.`,
      details: {
        rolledBack: false,
        rollbackAttempted: true,
        rollbackBranch: null,
        rollbackOutput: result.output,
        rollbackInspectionFailed: true,
        rollbackError: errorMessage(error),
      },
    };
  }
  const rolledBack = result.success && after === originalBranch && workingTreeClean;
  return {
    text: rolledBack
      ? `Rolled back to original branch \`${originalBranch}\` safely.`
      : `Rollback failed: expected \`${originalBranch}\` with a clean working tree, found \`${after ?? "no branch"}\`${workingTreeClean ? "" : " with uncommitted changes"}.`,
    details: {
      rolledBack,
      rollbackAttempted: true,
      rollbackBranch: after,
      workingTreeClean,
      rollbackOutput: result.output,
    },
  };
}

function sameWorkspaceSnapshot(
  left: WorkspaceControllerSnapshot | undefined,
  right: WorkspaceControllerSnapshot,
): boolean {
  return (
    left?.activeBranch === right.activeBranch &&
    JSON.stringify(left?.branches) === JSON.stringify(right.branches) &&
    left?.baseBranch === right.baseBranch
  );
}

async function restoreWorkspaceSnapshotSignalFree(
  cwd: string,
  originalSnapshot: WorkspaceControllerSnapshot,
  controller: WorkspaceController,
): Promise<{ text: string; details: Record<string, unknown> }> {
  try {
    await controller.restore(cwd, originalSnapshot);
  } catch (error: unknown) {
    return {
      text: `Workspace ownership rollback failed: ${errorMessage(error)}.`,
      details: {
        workspaceRolledBack: false,
        workspaceRollbackAttempted: true,
        workspaceRestoreFailed: true,
        workspaceRollbackError: errorMessage(error),
      },
    };
  }
  try {
    const verifiedSnapshot = await controller.snapshot(cwd);
    const workspaceRolledBack = sameWorkspaceSnapshot(verifiedSnapshot, originalSnapshot);
    return {
      text: workspaceRolledBack
        ? "Workspace ownership was restored and verified."
        : "Workspace ownership restore completed, but verification found a different snapshot.",
      details: {
        workspaceRolledBack,
        workspaceRollbackAttempted: true,
        workspaceSnapshot: verifiedSnapshot,
        workspaceRollbackVerificationFailed: !workspaceRolledBack,
      },
    };
  } catch (error: unknown) {
    return {
      text: `Workspace ownership restore completed, but verification failed: ${errorMessage(error)}.`,
      details: {
        workspaceRolledBack: false,
        workspaceRollbackAttempted: true,
        workspaceRollbackVerificationFailed: true,
        workspaceRollbackError: errorMessage(error),
      },
    };
  }
}

export async function cleanupCheckout(
  cwd: string,
  originalBranch: string,
  originalSnapshot: WorkspaceControllerSnapshot,
  restoreBranch: WorkspaceBranchRestorer,
  controller: WorkspaceController,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const branch = await restoreBranchSignalFree(cwd, originalBranch, restoreBranch);
  const workspace = await restoreWorkspaceSnapshotSignalFree(cwd, originalSnapshot, controller);
  return {
    text: `${branch.text} ${workspace.text}`,
    details: {
      ...branch.details,
      ...workspace.details,
      rollbackVerified:
        branch.details.rolledBack === true && workspace.details.workspaceRolledBack === true,
    },
  };
}
