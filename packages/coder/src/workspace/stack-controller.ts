import type {
  WorkspaceController,
  WorkspaceControllerClaim,
  WorkspaceControllerSnapshot,
} from "@vt-agent/git_push";
import {
  assertManagedWorkspace,
  assertOwnedWorkspace,
  claimWorkspaceStack,
  loadWorkspace,
  replaceWorkspaceOwnership,
  validateWorkspaceStackClaim,
  type AgentWorkspace,
  type WorkspaceStackClaim,
  type WorkspaceStore,
} from "./logic.ts";

export interface WorkspaceStackControllerOptions {
  store: WorkspaceStore;
  getWorkspace: () => AgentWorkspace | undefined;
}

/** Bridges the host workspace registry to git_push's stack traversal hooks. */
export function createWorkspaceStackController(
  options: WorkspaceStackControllerOptions,
): WorkspaceController {
  const currentWorkspace = (): AgentWorkspace => {
    const workspace = options.getWorkspace();
    if (!workspace) throw new Error("No current managed workspace.");
    return workspace;
  };

  const latestWorkspace = async (): Promise<AgentWorkspace> => {
    const workspace = currentWorkspace();
    const latest = await loadWorkspace(options.store, workspace.id);
    Object.assign(workspace, latest);
    return workspace;
  };

  const claimFor = (claim: WorkspaceControllerClaim): WorkspaceStackClaim => ({
    baseBranch: claim.baseBranch,
    branches: claim.branches,
    activeBranch: claim.activeBranch,
  });

  return {
    async snapshot(cwd: string): Promise<WorkspaceControllerSnapshot> {
      const workspace = await latestWorkspace();
      await assertOwnedWorkspace(workspace, cwd);
      return {
        activeBranch: workspace.branch,
        branches: workspace.stack?.branches ?? [workspace.branch],
        baseBranch: workspace.stack?.baseBranch ?? null,
      };
    },

    async validate(cwd: string, claim: WorkspaceControllerClaim): Promise<void> {
      const workspace = await latestWorkspace();
      // Before checkout, ordinary ownership must still describe the current
      // checkout. The claim's active branch is intentionally not required to
      // be persisted yet.
      await assertOwnedWorkspace(workspace, cwd);
      await validateWorkspaceStackClaim(options.store, workspace, claimFor(claim));
    },

    async claim(cwd: string, claim: WorkspaceControllerClaim): Promise<void> {
      const workspace = await latestWorkspace();
      await assertManagedWorkspace(workspace, cwd, claim.activeBranch);
      const updated = await claimWorkspaceStack(
        options.store,
        workspace,
        {
          baseBranch: claim.baseBranch,
          branches: claim.branches,
        },
        claim.activeBranch,
      );
      Object.assign(workspace, updated);
    },

    async restore(cwd: string, snapshot: WorkspaceControllerSnapshot): Promise<void> {
      const workspace = await latestWorkspace();
      if (!snapshot.activeBranch) {
        throw new Error("Cannot restore workspace ownership without an active branch.");
      }
      if (snapshot.branches.length === 0) {
        throw new Error("Cannot restore workspace ownership without branches.");
      }
      if (snapshot.branches.length > 1 && snapshot.baseBranch === null) {
        throw new Error("Cannot restore a multi-branch workspace snapshot without a base branch.");
      }
      if (!snapshot.branches.includes(snapshot.activeBranch)) {
        throw new Error("Workspace snapshot active branch is not one of its branches.");
      }

      // Restore is called after the caller has returned the checkout to the
      // snapshot cursor. Verify that physical state before changing durable
      // ownership, and never persist a partial cursor/stack update.
      await assertManagedWorkspace(workspace, cwd, snapshot.activeBranch);
      const stack =
        snapshot.baseBranch === null
          ? undefined
          : { baseBranch: snapshot.baseBranch, branches: [...snapshot.branches] };
      const updated = await replaceWorkspaceOwnership(options.store, workspace, {
        branch: snapshot.activeBranch,
        stack,
      });
      Object.assign(workspace, updated);
    },
  };
}

export type { WorkspaceController, WorkspaceControllerClaim, WorkspaceControllerSnapshot };
