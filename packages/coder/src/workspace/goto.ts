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
  dependencies?: GotoDependencies;
}) {
  return function gotoExtension(pi: ExtensionAPI) {
    let pending: AgentWorkspace | undefined;
    let queue = Promise.resolve();

    pi.registerCommand("goto-workspace", {
      description: "Complete a pending agent workspace transition",
      handler: async (args, ctx) => {
        const id = args.trim();
        let workspace = pending;
        if (!workspace) {
          const dependencies = options.dependencies ?? defaultDependencies;
          const repository = await dependencies.resolveRepository(options.cwd);
          workspace = (
            await dependencies.listWorkspaces(options.store, repository.repository)
          ).find(
            (candidate) =>
              candidate.id === id &&
              candidate.status === "active" &&
              candidate.repository === repository.repository,
          );
        }
        if (!workspace || id !== workspace.id) {
          throw new Error("No matching workspace transition is pending.");
        }
        await ctx.waitForIdle();
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) throw new Error("The current session has not been saved yet.");
        await options.transition(workspace, sessionFile);
      },
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
      async execute(_toolCallId, params) {
        const previous = queue;
        let release!: () => void;
        queue = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          if (pending) throw new Error("A workspace transition is already pending.");
          pending = await createGotoWorkspace({
            store: options.store,
            cwd: options.cwd,
            branch: params.branch,
            dependencies: options.dependencies,
          });
          pi.sendUserMessage(`/goto-workspace ${pending.id}`, { deliverAs: "followUp" });
          return {
            content: [
              {
                type: "text" as const,
                text: `Created agent workspace ${pending.branch}. The session will continue in ${pending.worktree}.`,
              },
            ],
            details: { branch: pending.branch, worktree: pending.worktree },
            terminate: true,
          };
        } finally {
          release();
        }
      },
    });
  };
}
