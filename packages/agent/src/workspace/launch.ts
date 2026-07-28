import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  createWorkspace,
  listWorkspaces,
  resolveRepository,
  type AgentWorkspace,
  type WorkspaceStore,
} from "./logic.ts";

export type LaunchMode = "auto" | "new" | "continue" | "resume";

export function parseLaunchMode(args: string[]): LaunchMode {
  let mode: LaunchMode = "auto";
  for (const arg of args) {
    const next =
      arg === "--new"
        ? "new"
        : arg === "--continue" || arg === "-c"
          ? "continue"
          : arg === "--resume" || arg === "-r"
            ? "resume"
            : null;
    if (!next) throw new Error(`Unknown coder argument: ${arg}`);
    if (mode !== "auto") throw new Error("Choose only one of --new, --continue, or --resume.");
    mode = next;
  }
  return mode;
}

export function workspaceLabel(workspace: AgentWorkspace): string {
  const name = workspace.sessionName ?? "unnamed task";
  return `${name} · ${workspace.branch} · ${workspace.updatedAt}`;
}

async function promptForWorkspace(workspaces: AgentWorkspace[]): Promise<AgentWorkspace | "new"> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Multiple active agent tasks exist. Use --continue or run coder interactively.",
    );
  }

  stdout.write("\nAgent workspaces\n\n");
  workspaces.forEach((workspace, index) => {
    stdout.write(`  ${index + 1}. Continue: ${workspaceLabel(workspace)}\n`);
  });
  stdout.write(`  ${workspaces.length + 1}. Start a new task\n`);
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question("\nSelect task: ");
    const index = Number.parseInt(answer, 10) - 1;
    if (index === workspaces.length) return "new";
    const selected = workspaces[index];
    if (!selected) throw new Error("No workspace selected.");
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
  mode: LaunchMode;
  choose?: (workspaces: AgentWorkspace[]) => Promise<AgentWorkspace | "new">;
  dependencies?: WorkspaceSelectionDependencies;
}): Promise<{ workspace: AgentWorkspace; created: boolean }> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const repository = await dependencies.resolveRepository(options.cwd);
  const active = (await dependencies.listWorkspaces(options.store, repository.repository)).filter(
    (workspace) => workspace.status === "active",
  );

  if (options.mode === "new" || active.length === 0) {
    return {
      workspace: await dependencies.createWorkspace(options.store, options.cwd),
      created: true,
    };
  }
  if (options.mode === "continue" || (options.mode === "auto" && active.length === 1)) {
    return { workspace: active[0]!, created: false };
  }

  const choose = options.choose ?? promptForWorkspace;
  const selected = await choose(active);
  if (selected === "new") {
    return {
      workspace: await dependencies.createWorkspace(options.store, options.cwd),
      created: true,
    };
  }
  return { workspace: selected, created: false };
}
