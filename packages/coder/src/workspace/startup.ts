import type { SessionPointerStore } from "../session-pointer.ts";
import { LaunchError, selectWorkspace, type LaunchCommand } from "./launch.ts";
import { assertOwnedWorkspace, resolveRegularCheckout, type WorkspaceStore } from "./logic.ts";
import {
  reconcileMergedWorkspaces,
  removeWorkspaceByBranch,
  type WorkspaceReconciliationEntry,
  type WorkspaceReconciliationResult,
} from "./reconcile.ts";

interface StartupDependencies {
  resolveRegularCheckout: typeof resolveRegularCheckout;
  reconcileMergedWorkspaces: typeof reconcileMergedWorkspaces;
  removeWorkspaceByBranch: typeof removeWorkspaceByBranch;
  selectWorkspace: typeof selectWorkspace;
  assertOwnedWorkspace: typeof assertOwnedWorkspace;
}

const defaultDependencies: StartupDependencies = {
  resolveRegularCheckout,
  reconcileMergedWorkspaces,
  removeWorkspaceByBranch,
  selectWorkspace,
  assertOwnedWorkspace,
};

export async function prepareWorkspaceStartup(options: {
  store: WorkspaceStore;
  sourceCwd: string;
  launchCommand: LaunchCommand;
  sessionPointers: SessionPointerStore;
  dependencies?: StartupDependencies;
}): Promise<{
  primaryCheckout: string;
  reconciliation: WorkspaceReconciliationResult;
  selectedWorkspace?: Awaited<ReturnType<typeof selectWorkspace>>;
  deletedWorkspace?: WorkspaceReconciliationEntry;
}> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const primaryCheckout = await dependencies.resolveRegularCheckout(options.sourceCwd);

  if (options.launchCommand.kind === "delete") {
    try {
      const deletedWorkspace = await dependencies.removeWorkspaceByBranch(
        {
          store: options.store,
          cwd: primaryCheckout,
          sessionPointers: options.sessionPointers,
        },
        options.launchCommand.branch,
      );
      if (!deletedWorkspace) {
        throw new LaunchError(`No workspace exists for branch ${options.launchCommand.branch}.`);
      }
      return {
        primaryCheckout,
        reconciliation: { removed: [], retained: [] },
        deletedWorkspace,
      };
    } catch (error: unknown) {
      if (error instanceof LaunchError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new LaunchError(
        `Could not delete workspace ${options.launchCommand.branch}: ${message}`,
      );
    }
  }

  const reconciliation = await dependencies.reconcileMergedWorkspaces({
    store: options.store,
    cwd: primaryCheckout,
    sessionPointers: options.sessionPointers,
  });
  let selectedWorkspace: Awaited<ReturnType<typeof selectWorkspace>> | undefined;
  if (options.launchCommand.kind === "goto") {
    try {
      selectedWorkspace = await dependencies.selectWorkspace({
        store: options.store,
        cwd: primaryCheckout,
        branch: options.launchCommand.branch,
      });
      await dependencies.assertOwnedWorkspace(selectedWorkspace.workspace);
    } catch (error: unknown) {
      if (error instanceof LaunchError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new LaunchError(
        `Could not enter workspace ${options.launchCommand.branch ?? selectedWorkspace?.workspace.branch}: ${message}`,
      );
    }
  }
  return { primaryCheckout, reconciliation, selectedWorkspace };
}
