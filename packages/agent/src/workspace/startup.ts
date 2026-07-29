import type { SessionPointerStore } from "../session-pointer.ts";
import { selectWorkspace, type LaunchCommand } from "./launch.ts";
import { resolveRegularCheckout, type WorkspaceStore } from "./logic.ts";
import { reconcileMergedWorkspaces, type WorkspaceReconciliationResult } from "./reconcile.ts";

interface StartupDependencies {
  resolveRegularCheckout: typeof resolveRegularCheckout;
  reconcileMergedWorkspaces: typeof reconcileMergedWorkspaces;
  selectWorkspace: typeof selectWorkspace;
}

const defaultDependencies: StartupDependencies = {
  resolveRegularCheckout,
  reconcileMergedWorkspaces,
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
}> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const primaryCheckout = await dependencies.resolveRegularCheckout(options.sourceCwd);
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
