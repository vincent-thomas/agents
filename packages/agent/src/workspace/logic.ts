import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AgentWorkspace {
  version: 1;
  id: string;
  repository: string;
  sourceRoot: string;
  worktree: string;
  branch: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "completed";
  sessionFile?: string;
  sessionName?: string;
}

export interface WorkspaceStore {
  stateDir: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function recordsDir(store: WorkspaceStore): string {
  return join(store.stateDir, "workspaces", "records");
}

function recordPath(store: WorkspaceStore, id: string): string {
  return join(recordsDir(store), `${id}.json`);
}

function parseWorkspace(value: unknown, path: string): AgentWorkspace {
  if (!value || typeof value !== "object") throw new Error(`Invalid workspace record: ${path}`);
  const record = value as Partial<AgentWorkspace>;
  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    typeof record.repository !== "string" ||
    typeof record.sourceRoot !== "string" ||
    typeof record.worktree !== "string" ||
    typeof record.branch !== "string" ||
    typeof record.baseSha !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    (record.status !== "active" && record.status !== "completed")
  ) {
    throw new Error(`Invalid workspace record: ${path}`);
  }
  return record as AgentWorkspace;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveRepository(cwd: string): Promise<{
  repository: string;
  sourceRoot: string;
  head: string;
}> {
  const sourceRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const commonDirOutput = (await git(sourceRoot, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const commonDir = isAbsolute(commonDirOutput)
    ? commonDirOutput
    : resolve(sourceRoot, commonDirOutput);
  const repository = await realpath(commonDir);
  const head = (await git(sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { repository, sourceRoot: await realpath(sourceRoot), head };
}

export async function saveWorkspace(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
): Promise<void> {
  const path = recordPath(store, workspace.id);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function loadWorkspace(store: WorkspaceStore, id: string): Promise<AgentWorkspace> {
  const path = recordPath(store, id);
  return parseWorkspace(JSON.parse(await readFile(path, "utf8")), path);
}

export async function listWorkspaces(
  store: WorkspaceStore,
  repository: string,
): Promise<AgentWorkspace[]> {
  const directory = recordsDir(store);
  if (!(await pathExists(directory))) return [];

  const entries = await readdir(directory, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        return parseWorkspace(JSON.parse(await readFile(path, "utf8")), path);
      }),
  );

  return records
    .filter((record) => record.repository === repository)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function assertNewBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ["check-ref-format", "--branch", branch]);
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch (error: unknown) {
    if ((error as { code?: number }).code === 1) return;
    throw error;
  }
  throw new Error(`Branch already exists: ${branch}`);
}

export async function createWorkspace(
  store: WorkspaceStore,
  cwd: string,
  branch: string,
): Promise<AgentWorkspace> {
  const repo = await resolveRepository(cwd);
  await assertNewBranch(repo.sourceRoot, branch);
  const id = randomUUID();
  const repoKey = `${basename(repo.sourceRoot)}-${createHash("sha256")
    .update(repo.repository)
    .digest("hex")
    .slice(0, 12)}`;
  const worktree = join(store.stateDir, "workspaces", "worktrees", repoKey, id);
  await mkdir(dirname(worktree), { recursive: true });
  await git(repo.sourceRoot, ["worktree", "add", "-b", branch, worktree, repo.head]);

  const now = new Date().toISOString();
  const workspace: AgentWorkspace = {
    version: 1,
    id,
    repository: repo.repository,
    sourceRoot: repo.sourceRoot,
    worktree,
    branch,
    baseSha: repo.head,
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
  await saveWorkspace(store, workspace);
  return workspace;
}

export async function updateWorkspace(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
  patch: Pick<Partial<AgentWorkspace>, "sessionFile" | "sessionName" | "status">,
): Promise<AgentWorkspace> {
  const updated: AgentWorkspace = {
    ...workspace,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await saveWorkspace(store, updated);
  return updated;
}

export async function assertWorkspacePath(expected: string, cwd = expected): Promise<void> {
  const actualCwd = await realpath(cwd);
  const expectedCwd = await realpath(expected);
  if (actualCwd !== expectedCwd) {
    throw new Error(`Workspace path mismatch: expected ${expectedCwd}, found ${actualCwd}.`);
  }
}

export async function assertOwnedWorkspace(
  workspace: AgentWorkspace,
  cwd = workspace.worktree,
): Promise<void> {
  if (workspace.status !== "active") {
    throw new Error(`Agent workspace ${workspace.id} is completed and read-only.`);
  }
  await assertWorkspacePath(workspace.worktree, cwd);
  const actualCwd = await realpath(cwd);
  const currentBranch = (
    await git(actualCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  ).stdout.trim();
  if (currentBranch !== workspace.branch) {
    throw new Error(
      `Agent workspace branch mismatch: expected ${workspace.branch}, found ${currentBranch}.`,
    );
  }
  const repository = await resolveRepository(actualCwd);
  if (repository.repository !== workspace.repository) {
    throw new Error(`Agent workspace ${workspace.id} belongs to a different repository.`);
  }
}
