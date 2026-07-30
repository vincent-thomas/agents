import type { SessionPointerStore } from "../session-pointer.ts";
import { LaunchError, selectWorkspace, type LaunchCommand } from "./launch.ts";
import { resolveRegularCheckout, type WorkspaceStore } from "./logic.ts";
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
}

const defaultDependencies: StartupDependencies = {
  resolveRegularCheckout,
  reconcileMergedWorkspaces,
  removeWorkspaceByBranch,
  selectWorkspace,
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
  const selectedWorkspace =
    options.launchCommand.kind === "goto"
      ? await dependencies.selectWorkspace({
          store: options.store,
          cwd: primaryCheckout,
          branch: options.launchCommand.branch,
        })
      : undefined;
  return { primaryCheckout, reconciliation, selectedWorkspace };
}
