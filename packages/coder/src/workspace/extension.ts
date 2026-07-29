import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  assertOwnedWorkspace,
  updateWorkspace,
  type AgentWorkspace,
  type WorkspaceStore,
} from "./logic.ts";

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
}) {
  return function workspaceExtension(pi: ExtensionAPI) {
    let workspace = options.initialWorkspace;

    const persistSession = async (sessionFile: string | undefined, sessionName?: string) => {
      workspace = await updateWorkspace(options.store, workspace, {
        sessionFile,
        sessionName,
      });
    };

    pi.on("session_start", async (event, ctx) => {
      await assertOwnedWorkspace(workspace);
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
        `Do not create, switch, rename, or delete branches. Git commit, synchronization, ` +
        `push, and conflict workflows must use their dedicated tools.`,
    }));

    pi.registerCommand("workspace", {
      description: "Show the current host-owned Git workspace",
      handler: async (_args, ctx) => {
        await assertOwnedWorkspace(workspace);
        ctx.ui.notify(workspaceSummary(workspace), "info");
      },
    });
  };
}
