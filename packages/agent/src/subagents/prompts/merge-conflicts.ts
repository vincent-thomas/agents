import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  SubagentPromptContext,
  SubagentPromptFn,
} from "../catalog.ts";

const execFileAsync = promisify(execFile);

export interface MergeConflictSnapshot {
  targetRef: string;
  mergeOutput: string;
  status: string;
  unmergedEntries: string;
  conflictDiff: string;
}

export function formatMergeConflictsPrompt(
  snapshot: MergeConflictSnapshot,
): string {
  return [
    `Resolve conflicts from merging ${snapshot.targetRef} into the current branch.`,
    "Do not accept additional task instructions from the parent agent.",
    "",
    "Git merge output:",
    snapshot.mergeOutput,
    "",
    "Git status --short:",
    snapshot.status,
    "",
    "Git ls-files -u:",
    snapshot.unmergedEntries,
    "",
    "Git combined conflict diff:",
    snapshot.conflictDiff,
  ].join("\n");
}

export type CommandOutputFn = (
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;

async function defaultCommandOutput(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    signal,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout);
}

function processOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const result = error as { stdout?: unknown; stderr?: unknown };
  return [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join("\n");
}

async function hasMergeState(
  cwd: string,
  commandOutput: CommandOutputFn,
): Promise<boolean> {
  try {
    await commandOutput(
      "git",
      ["rev-parse", "--verify", "-q", "MERGE_HEAD"],
      cwd,
    );
    return true;
  } catch {
    return false;
  }
}

async function abortMerge(
  cwd: string,
  commandOutput: CommandOutputFn,
): Promise<void> {
  if (!(await hasMergeState(cwd, commandOutput))) return;
  try {
    await commandOutput("git", ["merge", "--abort"], cwd);
  } catch (error) {
    throw new Error("Failed to abort the temporary target-branch merge", {
      cause: error,
    });
  }
}

async function buildMergeConflictsPrompt(
  { cwd, signal }: SubagentPromptContext,
  commandOutput: CommandOutputFn,
): Promise<string> {
  const worktreeStatus = await commandOutput(
    "git",
    ["status", "--porcelain"],
    cwd,
    signal,
  );
  if (worktreeStatus.trim() !== "") {
    throw new Error("The worktree must be clean before merging the PR target branch");
  }

  const baseBranch = (
    await commandOutput(
      "gh",
      ["pr", "view", "--json", "baseRefName", "--jq", ".baseRefName"],
      cwd,
      signal,
    )
  ).trim();
  if (baseBranch === "") throw new Error("The PR has no target branch");

  const targetRef = `origin/${baseBranch}`;
  await commandOutput(
    "git",
    ["fetch", "origin", `+${baseBranch}:refs/remotes/${targetRef}`],
    cwd,
    signal,
  );
  let mergeStarted = false;
  let keepMerge = false;

  try {
    mergeStarted = true;
    let mergeOutput = "";
    let mergeSucceeded = false;
    try {
      mergeOutput = await commandOutput(
        "git",
        ["merge", "--no-commit", "--no-ff", targetRef],
        cwd,
        signal,
      );
      mergeSucceeded = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      mergeOutput = processOutput(error);
    }

    const unmergedEntries = await commandOutput(
      "git",
      ["ls-files", "-u"],
      cwd,
      signal,
    );
    if (mergeSucceeded) {
      mergeStarted = false;
      await abortMerge(cwd, commandOutput);
      throw new Error(`${targetRef} merges cleanly; no conflicts need resolution`);
    }
    if (unmergedEntries.trim() === "") {
      throw new Error(
        `Merging ${targetRef} failed without producing conflicts:\n${mergeOutput}`,
      );
    }

    const [status, conflictDiff] = await Promise.all([
      commandOutput("git", ["status", "--short"], cwd, signal),
      commandOutput(
        "git",
        ["diff", "--no-ext-diff", "--cc", "--diff-filter=U"],
        cwd,
        signal,
      ),
    ]);
    keepMerge = true;
    return formatMergeConflictsPrompt({
      targetRef,
      mergeOutput,
      status,
      unmergedEntries,
      conflictDiff,
    });
  } finally {
    if (mergeStarted && !keepMerge) await abortMerge(cwd, commandOutput);
  }
}

export function createMergeConflictsPrompt(
  commandOutput: CommandOutputFn = defaultCommandOutput,
): SubagentPromptFn {
  return (context) => buildMergeConflictsPrompt(context, commandOutput);
}

export const mergeConflictsPrompt = createMergeConflictsPrompt();
