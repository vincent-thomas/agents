import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { SessionPointerStore } from "../session-pointer.ts";
import {
  deleteWorkspace,
  inspectWorkspaceForRemoval,
  listWorkspaces,
  removeWorkspaceWorktree,
  resolveRepository,
  updateWorkspace,
  type AgentWorkspace,
  type WorkspaceStore,
} from "./logic.ts";

const execFileAsync = promisify(execFile);

export interface MergedPullRequest {
  number: number;
  headSha: string;
}

export interface WorkspaceReconciliationEntry {
  workspaceId: string;
  branch: string;
  prNumber?: number;
  reason?: string;
  actionable?: boolean;
}

export interface WorkspaceReconciliationResult {
  removed: WorkspaceReconciliationEntry[];
  retained: WorkspaceReconciliationEntry[];
}

type FindMergedPullRequest = (
  cwd: string,
  branch: string,
  headSha: string,
  signal?: AbortSignal,
) => Promise<MergedPullRequest | null>;

export interface ReconcileMergedWorkspacesOptions {
  store: WorkspaceStore;
  cwd: string;
  sessionPointers: SessionPointerStore;
  signal?: AbortSignal;
  findMergedPullRequest?: FindMergedPullRequest;
}

interface PullRequestJson {
  number?: unknown;
  headRefOid?: unknown;
}

export async function findMergedPullRequest(
  cwd: string,
  branch: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<MergedPullRequest | null> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--json",
      "number,headRefOid",
      "--limit",
      "20",
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
      signal,
    },
  );
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value)) throw new Error("GitHub returned an invalid pull request list.");
  const pullRequests = value.flatMap((entry: PullRequestJson) =>
    typeof entry.number === "number" && typeof entry.headRefOid === "string"
      ? [{ number: entry.number, headSha: entry.headRefOid }]
      : [],
  );
  return (
    pullRequests.find((pullRequest) => pullRequest.headSha === headSha) ?? pullRequests[0] ?? null
  );
}

async function localHead(worktree: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    signal,
  });
  return stdout.trim();
}

function retained(
  workspace: AgentWorkspace,
  reason: string,
  actionable = false,
  prNumber?: number,
): WorkspaceReconciliationEntry {
  return {
    workspaceId: workspace.id,
    branch: workspace.branch,
    ...(prNumber === undefined ? {} : { prNumber }),
    reason,
    ...(actionable ? { actionable: true } : {}),
  };
}

async function finishCleanup(
  options: ReconcileMergedWorkspacesOptions,
  workspace: AgentWorkspace,
  prNumber?: number,
  expectedHead?: string,
): Promise<WorkspaceReconciliationEntry> {
  await removeWorkspaceWorktree(options.store, workspace, options.cwd, expectedHead);
  if (workspace.sessionFile) await rm(workspace.sessionFile, { force: true });
  await options.sessionPointers.remove(workspace.worktree);
  await deleteWorkspace(options.store, workspace.id);
  return {
    workspaceId: workspace.id,
    branch: workspace.branch,
    ...(prNumber === undefined ? {} : { prNumber }),
  };
}

async function reconcileWorkspace(
  options: ReconcileMergedWorkspacesOptions,
  workspace: AgentWorkspace,
): Promise<{ removed?: WorkspaceReconciliationEntry; retained?: WorkspaceReconciliationEntry }> {
  if (workspace.status === "completed") {
    try {
      const inspected = await inspectWorkspaceForRemoval(options.store, workspace, options.cwd);
      if (inspected && workspace.completionHeadSha === undefined) {
        throw new Error("completed workspace is missing its verified pull request head");
      }
      return {
        removed: await finishCleanup(
          options,
          workspace,
          workspace.completionPrNumber,
          workspace.completionHeadSha,
        ),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { retained: retained(workspace, `cleanup retry failed: ${message}`, true) };
    }
  }

  try {
    await stat(workspace.worktree);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      return { retained: retained(workspace, `workspace is unavailable: ${message}`, true) };
    }
    try {
      return { removed: await finishCleanup(options, workspace) };
    } catch (cleanupError: unknown) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      return {
        retained: retained(workspace, `stale workspace cleanup failed: ${message}`, true),
      };
    }
  }

  let headSha: string;
  try {
    headSha = await localHead(workspace.worktree, options.signal);
  } catch {
    return { retained: retained(workspace, "workspace HEAD is unavailable") };
  }

  let pullRequest: MergedPullRequest | null;
  try {
    pullRequest = await (options.findMergedPullRequest ?? findMergedPullRequest)(
      options.cwd,
      workspace.branch,
      headSha,
      options.signal,
    );
  } catch {
    return { retained: retained(workspace, "pull request status is unavailable") };
  }
  if (!pullRequest) return { retained: retained(workspace, "no merged pull request") };
  if (pullRequest.headSha !== headSha) {
    return {
      retained: retained(
        workspace,
        "local HEAD differs from the merged pull request",
        false,
        pullRequest.number,
      ),
    };
  }

  let completed: AgentWorkspace;
  try {
    const inspected = await inspectWorkspaceForRemoval(options.store, workspace, options.cwd);
    if (!inspected) throw new Error(`Workspace ${workspace.branch} worktree is missing.`);
    if (inspected.head !== headSha) {
      throw new Error(`Workspace ${workspace.branch} advanced during reconciliation.`);
    }
    completed = await updateWorkspace(options.store, workspace, {
      status: "completed",
      completionHeadSha: headSha,
      completionPrNumber: pullRequest.number,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      retained: retained(workspace, message, true, pullRequest.number),
    };
  }

  try {
    return {
      removed: await finishCleanup(options, completed, pullRequest.number, headSha),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      retained: retained(completed, `cleanup failed: ${message}`, true, pullRequest.number),
    };
  }
}

export async function removeWorkspaceByBranch(
  options: ReconcileMergedWorkspacesOptions,
  branch: string,
): Promise<WorkspaceReconciliationEntry | undefined> {
  const repository = await resolveRepository(options.cwd);
  const workspace = (await listWorkspaces(options.store, repository.repository)).find(
    (candidate) => candidate.branch === branch,
  );
  return workspace ? finishCleanup(options, workspace) : undefined;
}

export async function reconcileMergedWorkspaces(
  options: ReconcileMergedWorkspacesOptions,
): Promise<WorkspaceReconciliationResult> {
  const repository = await resolveRepository(options.cwd);
  const workspaces = await listWorkspaces(options.store, repository.repository);
  const results = await Promise.all(
    workspaces.map((workspace) => reconcileWorkspace(options, workspace)),
  );
  return {
    removed: results.flatMap((result) => (result.removed ? [result.removed] : [])),
    retained: results.flatMap((result) => (result.retained ? [result.retained] : [])),
  };
}
