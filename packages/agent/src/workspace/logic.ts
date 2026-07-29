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
  branchSetup?: "created" | "reused-local" | "fetched-origin";
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
    (record.status !== "active" && record.status !== "completed") ||
    (record.branchSetup !== undefined &&
      record.branchSetup !== "created" &&
      record.branchSetup !== "reused-local" &&
      record.branchSetup !== "fetched-origin")
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

export async function resolveRegularCheckout(cwd: string): Promise<string> {
  const output = (await git(cwd, ["worktree", "list", "--porcelain", "-z"])).stdout;
  const entry = output.split("\0").find((field) => field.startsWith("worktree "));
  if (!entry) throw new Error(`Git did not report a primary worktree for ${cwd}.`);
  return realpath(entry.slice("worktree ".length));
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

function gitErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch (error: unknown) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

async function originBranchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ["remote", "get-url", "origin"]);
  } catch (error: unknown) {
    if ((error as { code?: number }).code === 2) return false;
    throw error;
  }

  try {
    await git(cwd, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
    return true;
  } catch (error: unknown) {
    if ((error as { code?: number }).code === 2) return false;
    throw error;
  }
}

export async function createWorkspace(
  store: WorkspaceStore,
  cwd: string,
  branch: string,
): Promise<AgentWorkspace> {
  const repo = await resolveRepository(cwd);
  await git(repo.sourceRoot, ["check-ref-format", "--branch", branch]);
  const localBranchExists = await refExists(repo.sourceRoot, `refs/heads/${branch}`);
  const remoteBranchExists = localBranchExists
    ? false
    : await originBranchExists(repo.sourceRoot, branch);
  const id = randomUUID();
  const repoKey = `${basename(repo.sourceRoot)}-${createHash("sha256")
    .update(repo.repository)
    .digest("hex")
    .slice(0, 12)}`;
  const worktree = join(store.stateDir, "workspaces", "worktrees", repoKey, id);
  await mkdir(dirname(worktree), { recursive: true });

  let branchSetup: AgentWorkspace["branchSetup"];
  if (localBranchExists) {
    try {
      await git(repo.sourceRoot, ["worktree", "add", worktree, branch]);
    } catch (error: unknown) {
      throw new Error(
        `Cannot create agent workspace from local branch ${branch}. ` +
          `It may already be checked out in another worktree.\n${gitErrorMessage(error)}`,
        { cause: error },
      );
    }
    branchSetup = "reused-local";
  } else if (remoteBranchExists) {
    await git(repo.sourceRoot, [
      "fetch",
      "origin",
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    await git(repo.sourceRoot, [
      "worktree",
      "add",
      "--track",
      "-b",
      branch,
      worktree,
      `refs/remotes/origin/${branch}`,
    ]);
    branchSetup = "fetched-origin";
  } else {
    await git(repo.sourceRoot, ["worktree", "add", "-b", branch, worktree, repo.head]);
    branchSetup = "created";
  }

  const baseSha = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  const now = new Date().toISOString();
  const workspace: AgentWorkspace = {
    version: 1,
    id,
    repository: repo.repository,
    sourceRoot: repo.sourceRoot,
    worktree,
    branch,
    baseSha,
    createdAt: now,
    updatedAt: now,
    status: "active",
    branchSetup,
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
