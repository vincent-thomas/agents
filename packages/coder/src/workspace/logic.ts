import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkspaceTransitionPhase = "pending" | "switching" | "active" | "failed";

export interface WorkspaceTransitionMetadata {
  phase: WorkspaceTransitionPhase;
  sourceSessionFile: string;
  targetSessionFile?: string;
  error?: string;
}

export interface WorkspaceStackMetadata {
  baseBranch: string;
  branches: string[];
}

export interface AgentWorkspace {
  version: 1;
  id: string;
  repository: string;
  sourceRoot: string;
  worktree: string;
  /** The active checkout; stack members are recorded separately in `stack`. */
  branch: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "completed";
  stack?: WorkspaceStackMetadata;
  branchSetup?: "created" | "reused-local" | "fetched-origin";
  completionHeadSha?: string;
  completionPrNumber?: number;
  sessionFile?: string;
  sessionName?: string;
  transition?: WorkspaceTransitionMetadata;
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

async function canonicalizeMissingPath(path: string): Promise<string> {
  let candidate = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function isWorktreeRegistered(cwd: string, path: string): Promise<boolean> {
  const output = (await git(cwd, ["worktree", "list", "--porcelain", "-z"])).stdout;
  const registeredPaths = output.split("\0").flatMap((field) => {
    if (!field.startsWith("worktree ")) return [];
    return [field.slice("worktree ".length)];
  });
  const expected = await canonicalizeMissingPath(path);
  for (const registeredPath of registeredPaths) {
    if ((await canonicalizeMissingPath(registeredPath)) === expected) return true;
  }
  return false;
}

function recordsDir(store: WorkspaceStore): string {
  return join(store.stateDir, "workspaces", "records");
}

function repositoryLockPath(store: WorkspaceStore, repository: string): string {
  const key = createHash("sha256").update(repository).digest("hex");
  return join(store.stateDir, "workspaces", "locks", `${key}.lock`);
}

const workspaceLockWaitMs = 1_000;
const workspaceLockPollMs = 20;

interface WorkspaceLockOwner {
  pid: number;
  token: string;
}

async function readWorkspaceLockOwner(path: string): Promise<WorkspaceLockOwner | undefined> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (/^[0-9]+$/.test(raw)) {
      const pid = Number(raw);
      return Number.isSafeInteger(pid) && pid > 0 ? { pid, token: "" } : undefined;
    }
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as WorkspaceLockOwner).pid !== "number" ||
      !Number.isInteger((value as WorkspaceLockOwner).pid) ||
      (value as WorkspaceLockOwner).pid <= 0
    ) {
      return undefined;
    }
    return {
      pid: (value as WorkspaceLockOwner).pid,
      token:
        typeof (value as WorkspaceLockOwner).token === "string"
          ? (value as WorkspaceLockOwner).token
          : "",
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function recoverDeadWorkspaceLock(lockPath: string): Promise<boolean> {
  const owner = await readWorkspaceLockOwner(join(lockPath, "owner.json"));
  if (!owner || isProcessAlive(owner.pid)) return false;

  const abandonedPath = `${lockPath}.abandoned-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, abandonedPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  await rm(abandonedPath, { recursive: true, force: true });
  return true;
}

async function acquireWorkspaceLock(
  store: WorkspaceStore,
  repository: string,
): Promise<() => Promise<void>> {
  const lockPath = repositoryLockPath(store, repository);
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + workspaceLockWaitMs;
  const token = randomUUID();
  const owner: WorkspaceLockOwner = { pid: process.pid, token };

  while (true) {
    let createdLock = false;
    try {
      await mkdir(lockPath);
      createdLock = true;
      const temporaryOwner = join(lockPath, `.owner-${randomUUID()}.tmp`);
      await writeFile(temporaryOwner, `${JSON.stringify(owner)}\n`, "utf8");
      await rename(temporaryOwner, join(lockPath, "owner.json"));
      return async () => {
        const current = await readWorkspaceLockOwner(join(lockPath, "owner.json"));
        if (current?.token === token && current.pid === process.pid) {
          await rm(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!createdLock && code === "EEXIST") {
        if (await recoverDeadWorkspaceLock(lockPath)) {
          if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for the workspace registry lock for ${repository}.`);
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the workspace registry lock for ${repository}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, workspaceLockPollMs));
        continue;
      }
      if (createdLock) await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
  }
}

async function withWorkspaceLock<T>(
  store: WorkspaceStore,
  repository: string,
  action: () => Promise<T>,
): Promise<T> {
  const release = await acquireWorkspaceLock(store, repository);
  try {
    return await action();
  } finally {
    await release();
  }
}

function recordPath(store: WorkspaceStore, id: string): string {
  return join(recordsDir(store), `${id}.json`);
}

function isWorkspaceStack(value: unknown): value is WorkspaceStackMetadata {
  if (!value || typeof value !== "object") return false;
  const stack = value as Partial<WorkspaceStackMetadata>;
  return (
    typeof stack.baseBranch === "string" &&
    stack.baseBranch.trim().length > 0 &&
    Array.isArray(stack.branches) &&
    stack.branches.length > 0 &&
    stack.branches.every(
      (branch): branch is string => typeof branch === "string" && branch.trim().length > 0,
    ) &&
    new Set(stack.branches).size === stack.branches.length
  );
}

function isWorkspaceTransition(value: unknown): value is WorkspaceTransitionMetadata {
  if (!value || typeof value !== "object") return false;
  const transition = value as Partial<WorkspaceTransitionMetadata>;
  return (
    (transition.phase === "pending" ||
      transition.phase === "switching" ||
      transition.phase === "active" ||
      transition.phase === "failed") &&
    typeof transition.sourceSessionFile === "string" &&
    (transition.targetSessionFile === undefined ||
      typeof transition.targetSessionFile === "string") &&
    (transition.error === undefined || typeof transition.error === "string")
  );
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
    (record.stack !== undefined && !isWorkspaceStack(record.stack)) ||
    (record.stack !== undefined && !record.stack.branches.includes(record.branch)) ||
    (record.completionHeadSha !== undefined && typeof record.completionHeadSha !== "string") ||
    (record.completionPrNumber !== undefined && typeof record.completionPrNumber !== "number") ||
    (record.transition !== undefined && !isWorkspaceTransition(record.transition)) ||
    (record.branchSetup !== undefined &&
      record.branchSetup !== "created" &&
      record.branchSetup !== "reused-local" &&
      record.branchSetup !== "fetched-origin")
  ) {
    throw new Error(`Invalid workspace record: ${path}`);
  }
  return record as AgentWorkspace;
}

export function workspaceBranches(workspace: AgentWorkspace): string[] {
  return workspace.stack?.branches ?? [workspace.branch];
}

export function workspaceOwnsBranch(workspace: AgentWorkspace, branch: string): boolean {
  return workspaceBranches(workspace).includes(branch);
}

export interface WorkspaceStackClaim {
  baseBranch: string;
  branches: string[];
  activeBranch: string;
}

function validateWorkspace(workspace: AgentWorkspace, path: string): void {
  parseWorkspace(workspace, path);
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

async function saveWorkspaceUnlocked(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
): Promise<void> {
  const path = recordPath(store, workspace.id);
  validateWorkspace(workspace, path);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function saveWorkspace(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
): Promise<void> {
  await withWorkspaceLock(store, workspace.repository, () =>
    saveWorkspaceUnlocked(store, workspace),
  );
}

export async function loadWorkspace(store: WorkspaceStore, id: string): Promise<AgentWorkspace> {
  const path = recordPath(store, id);
  return parseWorkspace(JSON.parse(await readFile(path, "utf8")), path);
}

export async function deleteWorkspace(store: WorkspaceStore, id: string): Promise<void> {
  let workspace: AgentWorkspace;
  try {
    workspace = await loadWorkspace(store, id);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await withWorkspaceLock(store, workspace.repository, () =>
    rm(recordPath(store, id), { force: true }),
  );
}

async function listWorkspacesUnlocked(
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

export async function listWorkspaces(
  store: WorkspaceStore,
  repository: string,
): Promise<AgentWorkspace[]> {
  return listWorkspacesUnlocked(store, repository);
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
  initial?: Pick<AgentWorkspace, "transition">,
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
    ...initial,
  };
  await saveWorkspace(store, workspace);
  return workspace;
}

export interface WorkspaceOwnership {
  branch: string;
  stack?: WorkspaceStackMetadata;
}

async function updateWorkspaceUnlocked(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
  patch: Pick<
    Partial<AgentWorkspace>,
    | "branch"
    | "stack"
    | "completionHeadSha"
    | "completionPrNumber"
    | "sessionFile"
    | "sessionName"
    | "status"
    | "transition"
  >,
): Promise<AgentWorkspace> {
  const updated: AgentWorkspace = {
    ...workspace,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await saveWorkspaceUnlocked(store, updated);
  return updated;
}

export async function updateWorkspace(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
  patch: Pick<
    Partial<AgentWorkspace>,
    | "branch"
    | "stack"
    | "completionHeadSha"
    | "completionPrNumber"
    | "sessionFile"
    | "sessionName"
    | "status"
    | "transition"
  >,
): Promise<AgentWorkspace> {
  return withWorkspaceLock(store, workspace.repository, async () => {
    const current = await loadWorkspace(store, workspace.id);
    return updateWorkspaceUnlocked(store, current, patch);
  });
}

async function validateWorkspaceOwnershipUnlocked(
  store: WorkspaceStore,
  current: AgentWorkspace,
  ownership: WorkspaceOwnership,
): Promise<void> {
  if (current.status !== "active") {
    throw new Error(`Agent workspace ${current.id} is completed and read-only.`);
  }
  if (ownership.stack !== undefined && !isWorkspaceStack(ownership.stack)) {
    throw new Error("Invalid workspace stack metadata.");
  }
  const candidate = { ...current, branch: ownership.branch, stack: ownership.stack };
  validateWorkspace(candidate, recordPath(store, current.id));

  const ownedBranches = ownership.stack?.branches ?? [ownership.branch];
  const overlap = (await listWorkspacesUnlocked(store, current.repository))
    .filter((other) => other.id !== current.id)
    .flatMap((other) => workspaceBranches(other))
    .find((branch) => ownedBranches.includes(branch));
  if (overlap !== undefined) {
    throw new Error(`Branch ${overlap} is already owned by another workspace.`);
  }
}

async function validateWorkspaceStackClaimUnlocked(
  store: WorkspaceStore,
  current: AgentWorkspace,
  claim: WorkspaceStackClaim,
): Promise<WorkspaceStackMetadata> {
  const stack: WorkspaceStackMetadata = {
    baseBranch: claim.baseBranch,
    branches: claim.branches,
  };
  if (!isWorkspaceStack(stack)) {
    throw new Error("Invalid workspace stack metadata.");
  }
  await validateWorkspaceOwnershipUnlocked(store, current, {
    branch: claim.activeBranch,
    stack,
  });
  return stack;
}

/**
 * Validate a stack claim against the latest persisted workspace and all other
 * workspaces. This is deliberately read-only so callers can preflight the
 * exact claim they will later persist.
 */
export async function validateWorkspaceStackClaim(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
  claim: WorkspaceStackClaim,
): Promise<void> {
  await withWorkspaceLock(store, workspace.repository, async () => {
    const current = await loadWorkspace(store, workspace.id);
    await validateWorkspaceStackClaimUnlocked(store, current, claim);
  });
}

/**
 * Replace the active cursor and its ownership metadata atomically. An omitted
 * stack restores legacy ownership of only the active branch.
 */
export async function replaceWorkspaceOwnership(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
  ownership: WorkspaceOwnership,
): Promise<AgentWorkspace> {
  return withWorkspaceLock(store, workspace.repository, async () => {
    const current = await loadWorkspace(store, workspace.id);
    await validateWorkspaceOwnershipUnlocked(store, current, ownership);
    return updateWorkspaceUnlocked(store, current, ownership);
  });
}

/**
 * Claim a set of stack branches for an active workspace. Loading, validation,
 * and persistence all happen under one repository lock.
 */
export async function claimWorkspaceStack(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
  stack: WorkspaceStackMetadata,
  activeBranch = workspace.branch,
): Promise<AgentWorkspace> {
  return withWorkspaceLock(store, workspace.repository, async () => {
    const current = await loadWorkspace(store, workspace.id);
    const validatedStack = await validateWorkspaceStackClaimUnlocked(store, current, {
      ...stack,
      activeBranch,
    });
    return updateWorkspaceUnlocked(store, current, {
      branch: activeBranch,
      stack: validatedStack,
    });
  });
}

export async function inspectWorkspaceForRemoval(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
  primaryCheckout: string,
): Promise<{ path: string; head: string } | undefined> {
  const managedRoot = resolve(store.stateDir, "workspaces", "worktrees");
  const recordedPath = resolve(workspace.worktree);
  const recordedRelative = relative(managedRoot, recordedPath);
  if (recordedRelative.startsWith("..") || isAbsolute(recordedRelative)) {
    throw new Error(`Workspace ${workspace.id} is outside the managed worktree directory.`);
  }
  if (!(await pathExists(recordedPath))) return undefined;

  const [actualWorktree, actualPrimary, actualManagedRoot] = await Promise.all([
    realpath(recordedPath),
    realpath(primaryCheckout),
    realpath(managedRoot),
  ]);
  const managedRelative = relative(actualManagedRoot, actualWorktree);
  if (managedRelative.startsWith("..") || isAbsolute(managedRelative)) {
    throw new Error(`Workspace ${workspace.id} is outside the managed worktree directory.`);
  }
  if (actualWorktree === actualPrimary) {
    throw new Error(`Workspace ${workspace.id} is the primary checkout.`);
  }

  const branch = (
    await git(actualWorktree, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  ).stdout.trim();
  if (branch !== workspace.branch) {
    throw new Error(
      `Workspace branch mismatch: expected ${workspace.branch}, found ${branch || "detached HEAD"}.`,
    );
  }
  const repository = await resolveRepository(actualWorktree);
  if (repository.repository !== workspace.repository) {
    throw new Error(`Workspace ${workspace.id} belongs to a different repository.`);
  }
  const status = (await git(actualWorktree, ["status", "--porcelain"])).stdout;
  if (status.trim()) throw new Error(`Workspace ${workspace.branch} has uncommitted changes.`);
  const head = (await git(actualWorktree, ["rev-parse", "HEAD"])).stdout.trim();
  return { path: actualWorktree, head };
}

export async function removeWorkspaceWorktree(
  store: WorkspaceStore,
  workspace: AgentWorkspace,
  primaryCheckout: string,
  expectedHead?: string,
): Promise<boolean> {
  const inspected = await inspectWorkspaceForRemoval(store, workspace, primaryCheckout);
  if (!inspected) {
    const repository = await resolveRepository(primaryCheckout);
    if (repository.repository !== workspace.repository) {
      throw new Error(`Workspace ${workspace.id} belongs to a different repository.`);
    }
    const recordedPath = resolve(workspace.worktree);
    if (await isWorktreeRegistered(primaryCheckout, recordedPath)) {
      await git(primaryCheckout, ["worktree", "prune", "--expire", "now"]);
      if (await isWorktreeRegistered(primaryCheckout, recordedPath)) {
        throw new Error(
          `Stale Git registration for workspace ${workspace.id} could not be removed.`,
        );
      }
    }
    return false;
  }
  if (expectedHead !== undefined && inspected.head !== expectedHead) {
    throw new Error(`Workspace ${workspace.branch} advanced after its pull request was merged.`);
  }
  await git(primaryCheckout, ["worktree", "remove", inspected.path]);
  return true;
}

export async function assertWorkspacePath(expected: string, cwd = expected): Promise<void> {
  const actualCwd = await realpath(cwd);
  const expectedCwd = await realpath(expected);
  if (actualCwd !== expectedCwd) {
    throw new Error(`Workspace path mismatch: expected ${expectedCwd}, found ${actualCwd}.`);
  }
}

/**
 * Validate the physical managed checkout without requiring its branch to be in
 * the workspace's persisted ownership list. This is used while adopting a
 * stack member whose cursor has not been persisted yet.
 */
export async function assertManagedWorkspace(
  workspace: AgentWorkspace,
  cwd = workspace.worktree,
  expectedBranch = workspace.branch,
): Promise<string> {
  if (workspace.status !== "active") {
    throw new Error(`Agent workspace ${workspace.id} is completed and read-only.`);
  }
  await assertWorkspacePath(workspace.worktree, cwd);
  const actualCwd = await realpath(cwd);
  const currentBranch = (
    await git(actualCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  ).stdout.trim();
  if (currentBranch !== expectedBranch) {
    throw new Error(
      `Agent workspace branch mismatch: expected ${expectedBranch}, found ${currentBranch || "detached HEAD"}.`,
    );
  }
  const repository = await resolveRepository(actualCwd);
  if (repository.repository !== workspace.repository) {
    throw new Error(`Agent workspace ${workspace.id} belongs to a different repository.`);
  }
  return currentBranch;
}

export async function assertOwnedWorkspace(
  workspace: AgentWorkspace,
  cwd = workspace.worktree,
): Promise<void> {
  const currentBranch = await assertManagedWorkspace(workspace, cwd, workspace.branch);
  if (!workspaceOwnsBranch(workspace, currentBranch)) {
    throw new Error(
      `Agent workspace branch mismatch: expected ${workspace.branch}, found ${currentBranch}.`,
    );
  }
}
