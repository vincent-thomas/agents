import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  createWorkspace,
  listWorkspaces,
  resolveRepository,
  workspaceOwnsBranch,
  type AgentWorkspace,
  type WorkspaceStore,
} from "./logic.ts";

export type LaunchCommand =
  | { kind: "regular" }
  | { kind: "goto"; branch?: string }
  | { kind: "delete"; branch: string };

export class LaunchError extends Error {}

const usage = "Usage: coder [goto [branch-name] | goto --delete <branch-name>]";

export function parseLaunchCommand(args: string[]): LaunchCommand {
  if (args.length === 0) return { kind: "regular" };
  if (args[0] !== "goto") throw new LaunchError(usage);
  if (args[1] === "--delete") {
    if (args.length !== 3) throw new LaunchError(usage);
    return { kind: "delete", branch: args[2]! };
  }
  if (args.length > 2) throw new LaunchError(usage);
  return args[1] === undefined ? { kind: "goto" } : { kind: "goto", branch: args[1] };
}

export function workspaceLabel(workspace: AgentWorkspace): string {
  const name = workspace.sessionName ?? "unnamed task";
  return `${name} · ${workspace.branch} · ${workspace.updatedAt}`;
}

async function promptForWorkspace(workspaces: AgentWorkspace[]): Promise<AgentWorkspace> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new LaunchError(
      "Workspace selection requires an interactive terminal. Use coder goto <branch-name> instead.",
    );
  }

  stdout.write("\nAgent workspaces\n\n");
  workspaces.forEach((workspace, index) => {
    stdout.write(`  ${index + 1}. ${workspaceLabel(workspace)}\n`);
  });
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question("\nSelect workspace: ");
    const selected = workspaces[Number.parseInt(answer, 10) - 1];
    if (!selected) throw new LaunchError("No workspace selected.");
    return selected;
  } finally {
    readline.close();
  }
}

interface WorkspaceSelectionDependencies {
  resolveRepository: typeof resolveRepository;
  listWorkspaces: typeof listWorkspaces;
  createWorkspace: typeof createWorkspace;
}

const defaultDependencies: WorkspaceSelectionDependencies = {
  resolveRepository,
  listWorkspaces,
  createWorkspace,
};

export async function selectWorkspace(options: {
  store: WorkspaceStore;
  cwd: string;
  branch?: string;
  choose?: (workspaces: AgentWorkspace[]) => Promise<AgentWorkspace>;
  dependencies?: WorkspaceSelectionDependencies;
}): Promise<{ workspace: AgentWorkspace; created: boolean }> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const repository = await dependencies.resolveRepository(options.cwd);
  const active = (await dependencies.listWorkspaces(options.store, repository.repository)).filter(
    (workspace) => workspace.status === "active",
  );

  if (options.branch !== undefined) {
    const existing = active.find((workspace) => workspaceOwnsBranch(workspace, options.branch!));
    if (existing) return { workspace: existing, created: false };
    return {
      workspace: await dependencies.createWorkspace(options.store, options.cwd, options.branch),
      created: true,
    };
  }

  if (active.length === 0) {
    throw new LaunchError(
      "No active agent workspaces exist. Create one with coder goto <branch-name>.",
    );
  }

  const selected = await (options.choose ?? promptForWorkspace)(active);
  return { workspace: selected, created: false };
}
