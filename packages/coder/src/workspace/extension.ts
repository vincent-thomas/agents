import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  assertOwnedWorkspace,
  loadWorkspace,
  updateWorkspace,
  type AgentWorkspace,
  type WorkspaceStore,
} from "./logic.ts";

interface WorkspaceExtensionDependencies {
  assertOwnedWorkspace: typeof assertOwnedWorkspace;
  loadWorkspace: typeof loadWorkspace;
  updateWorkspace: typeof updateWorkspace;
}

const defaultDependencies: WorkspaceExtensionDependencies = {
  assertOwnedWorkspace,
  loadWorkspace,
  updateWorkspace,
};

export function workspaceStartupNotice(workspace: AgentWorkspace, created: boolean): string {
  if (!created) return `Resumed agent workspace ${workspace.branch}\n${workspace.worktree}`;

  const branchNotice =
    workspace.branchSetup === "reused-local"
      ? `Reused existing local branch ${workspace.branch}.`
      : workspace.branchSetup === "fetched-origin"
        ? `Fetched origin/${workspace.branch} and created a local tracking branch.`
        : undefined;
  return [branchNotice, `Created agent workspace ${workspace.branch}`, workspace.worktree]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function workspaceSummary(workspace: AgentWorkspace): string {
  return [
    `Task: ${workspace.sessionName ?? "unnamed"}`,
    `Branch: ${workspace.branch}`,
    `Base: ${workspace.baseSha}`,
    `Worktree: ${workspace.worktree}`,
    `Status: ${workspace.status}`,
    workspace.sessionFile ? `Session: ${workspace.sessionFile}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function createWorkspaceExtension(options: {
  store: WorkspaceStore;
  initialWorkspace: AgentWorkspace;
  created: boolean;
  dependencies?: WorkspaceExtensionDependencies;
}) {
  const dependencies = options.dependencies ?? defaultDependencies;
  return function workspaceExtension(pi: ExtensionAPI) {
    let workspace = options.initialWorkspace;

    const persistSession = async (sessionFile: string | undefined, sessionName?: string) => {
      const latest = await dependencies.loadWorkspace(options.store, workspace.id);
      const updated = await dependencies.updateWorkspace(options.store, latest, {
        sessionFile,
        sessionName,
      });
      Object.assign(workspace, updated);
    };

    pi.on("session_start", async (event, ctx) => {
      await dependencies.assertOwnedWorkspace(workspace);
      await persistSession(
        ctx.sessionManager.getSessionFile(),
        ctx.sessionManager.getSessionName() ?? undefined,
      );
      const label = workspace.sessionName ?? workspace.id.slice(0, 8);
      ctx.ui.setStatus("agent-workspace", `${label} · ${workspace.branch}`);
      if (event.reason === "startup") {
        ctx.ui.notify(workspaceStartupNotice(workspace, options.created), "info");
      }
    });

    pi.on("session_info_changed", async (event, ctx) => {
      await persistSession(ctx.sessionManager.getSessionFile(), event.name);
      const label = workspace.sessionName ?? workspace.id.slice(0, 8);
      ctx.ui.setStatus("agent-workspace", `${label} · ${workspace.branch}`);
    });

    pi.on("before_agent_start", async (event) => ({
      systemPrompt:
        event.systemPrompt +
        `\n\nYou are working in the host-owned Git workspace ${workspace.branch}. ` +
        `Do not directly create, switch, rename, or delete branches. Git commit, synchronization, ` +
        `push, and conflict workflows must use their dedicated tools. For a major request with ` +
        `separable changes, make each PR boundary an independently valid commit, then call ` +
        `create_github_stack with branch names and matching branch_points ordered base-to-tip; ` +
        `the owned workspace branch must be the final stack branch.`,
    }));

    pi.registerCommand("workspace", {
      description: "Show the current host-owned Git workspace",
      handler: async (_args, ctx) => {
        await dependencies.assertOwnedWorkspace(workspace);
        ctx.ui.notify(workspaceSummary(workspace), "info");
      },
    });
  };
}
