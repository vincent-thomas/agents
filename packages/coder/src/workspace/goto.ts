import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  createWorkspace,
  listWorkspaces,
  resolveRepository,
  type AgentWorkspace,
  type WorkspaceStore,
} from "./logic.ts";

interface GotoDependencies {
  resolveRepository: typeof resolveRepository;
  listWorkspaces: typeof listWorkspaces;
  createWorkspace: typeof createWorkspace;
}

const defaultDependencies: GotoDependencies = {
  resolveRepository,
  listWorkspaces,
  createWorkspace,
};

export async function createGotoWorkspace(options: {
  store: WorkspaceStore;
  cwd: string;
  branch: string;
  dependencies?: GotoDependencies;
}): Promise<AgentWorkspace> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const repository = await dependencies.resolveRepository(options.cwd);
  const existing = (await dependencies.listWorkspaces(options.store, repository.repository)).find(
    (workspace) => workspace.branch === options.branch,
  );
  if (existing) {
    throw new Error(`A workspace already exists for branch ${options.branch}.`);
  }
  return dependencies.createWorkspace(options.store, options.cwd, options.branch);
}

export function createGotoExtension(options: {
  store: WorkspaceStore;
  cwd: string;
  transition: (workspace: AgentWorkspace, sessionFile: string) => Promise<void>;
  scheduleTransition?: (transition: () => Promise<void>) => void;
  dependencies?: GotoDependencies;
}) {
  const scheduleTransition =
    options.scheduleTransition ??
    ((transition: () => Promise<void>) => {
      setTimeout(() => void transition(), 0);
    });

  return function gotoExtension(pi: ExtensionAPI) {
    let pending:
      | {
          workspace: AgentWorkspace;
          sessionFile: string;
        }
      | undefined;
    let transitionScheduled = false;
    let queue = Promise.resolve();

    pi.on("agent_settled", () => {
      if (!pending || transitionScheduled) return;
      transitionScheduled = true;
      const transition = pending;
      scheduleTransition(async () => {
        try {
          await options.transition(transition.workspace, transition.sessionFile);
          pending = undefined;
        } catch (error) {
          transitionScheduled = false;
          const message = `Workspace transition failed: ${error instanceof Error ? error.message : String(error)}`;
          try {
            pi.sendMessage({ customType: "goto-workspace-error", content: message, display: true });
          } catch {
            console.error(message);
          }
        }
      });
    });

    pi.registerTool({
      name: "goto",
      label: "Goto Workspace",
      description:
        "Create an agent-managed Git workspace for a branch and move this session into it. Errors if a workspace already exists for the branch.",
      promptSnippet: "Create and enter an agent-managed workspace for a branch",
      parameters: Type.Object({
        branch: Type.String({ description: "Git branch name for the new workspace" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const previous = queue;
        let release!: () => void;
        queue = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          if (pending) throw new Error("A workspace transition is already pending.");
          const sessionFile = ctx.sessionManager.getSessionFile();
          if (!sessionFile) throw new Error("The current session has not been saved yet.");
          const workspace = await createGotoWorkspace({
            store: options.store,
            cwd: options.cwd,
            branch: params.branch,
            dependencies: options.dependencies,
          });
          pending = { workspace, sessionFile };
          return {
            content: [
              {
                type: "text" as const,
                text: `Created agent workspace ${workspace.branch}. The session will continue in ${workspace.worktree}.`,
              },
            ],
            details: { branch: workspace.branch, worktree: workspace.worktree },
            terminate: true,
          };
        } finally {
          release();
        }
      },
    });
  };
}
