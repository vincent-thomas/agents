/**
 * logic.ts — helpers for git-commit extension.
 *
 * Uses shared helpers from lib for pre-checks, async exec, and git utilities.
 */
import { execAsync, execSucceeds, extractErrorOutput, tryExec } from "./exec-async.ts";
import { shellQuote } from "./shell-quote.ts";

// ---------------------------------------------------------------------------
// Branch checks
// ---------------------------------------------------------------------------

const GH_DEFAULT_BRANCH_QUERY =
  "gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null";

/**
 * Detect the repo's default branch (e.g. "main") via `gh`, falling back to
 * "main" if the lookup fails or `gh` isn't available.
 */
async function getDefaultBranch(cwd: string, signal?: AbortSignal): Promise<string> {
  const branch = await tryExec(GH_DEFAULT_BRANCH_QUERY, {
    cwd,
    timeout: 10_000,
    signal,
  });
  return branch ?? "main";
}

/**
 * Check if the given branch is the repository's default branch by querying
 * GitHub via `gh`. Returns true if it matches the default branch.
 */
export async function isDefaultBranch(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const defaultBranch = await getDefaultBranch(cwd, signal);
  return branch === defaultBranch;
}

/**
 * Check if the current branch exists on the remote.
 * Returns true if branch exists on remote, false otherwise.
 */
export async function branchExistsOnRemote(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  // ls-remote returns empty output if the branch doesn't exist; tryExec maps
  // both that and an outright failure to null, so a non-null result means the
  // branch is present on the remote.
  const stdout = await tryExec(`git ls-remote --heads origin ${shellQuote(branch)}`, {
    cwd,
    timeout: 10_000,
    signal,
  });
  return stdout !== null;
}

// ---------------------------------------------------------------------------
// Git commit
// ---------------------------------------------------------------------------

export interface CommitResult {
  success: boolean;
  output: string;
}

export function formatCommitMessage(subject: string, what: string, why: string): string {
  return `${subject}\n\nWhat: ${what}\nWhy: ${why}`;
}

/**
 * True if there are staged changes ready to commit.
 * `git diff --cached --quiet` exits 0 when nothing is staged and non-zero
 * when something is — flipped here so callers get a normally-named boolean
 * instead of having to remember which exit code means what.
 */
async function hasStagedChanges(cwd: string, signal?: AbortSignal): Promise<boolean> {
  return !(await execSucceeds("git diff --cached --quiet", {
    cwd,
    timeout: 5_000,
    signal,
  }));
}

/**
 * Commit the currently-staged changes with the given message.
 * Does NOT stage anything itself — the caller is responsible for staging
 * (e.g. with `git add`) beforehand.
 * Async to avoid blocking the event loop.
 */
export async function gitCommit(
  cwd: string,
  message?: string,
  signal?: AbortSignal,
): Promise<CommitResult> {
  if (message !== undefined && !(await hasStagedChanges(cwd, signal))) {
    return {
      success: false,
      output:
        "Nothing to commit — no staged changes. " +
        "Use `add_all: true` to auto-stage, or `git add` individual files.",
    };
  }

  // Commit.
  try {
    const command =
      message === undefined ? "git commit --no-edit" : `git commit -m ${shellQuote(message)}`;
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 30_000,
      signal,
    });
    return { success: true, output: (stdout + stderr).trim() };
  } catch (err: unknown) {
    return { success: false, output: extractErrorOutput(err) };
  }
}
