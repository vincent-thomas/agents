/**
 * git-utils.ts — git helpers used by the fix-ci tool.
 *
 * Self-contained copy, private to @vt-pi/fix-ci: a package keeps its own copy
 * of helpers resembling packages/agent-lord/lib/ rather than importing across
 * that boundary.
 */
import { execAsync, execSucceeds, tryExec } from "./exec-async.ts";

// ---------------------------------------------------------------------------
// Working tree checks
// ---------------------------------------------------------------------------

/**
 * Check whether the working tree has uncommitted changes (unstaged or
 * untracked). Returns true if dirty, false if clean. When git fails (e.g.
 * not in a repo), errs on the side of caution and returns true.
 */
export async function isWorktreeDirty(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd,
      timeout: 10_000,
      signal,
    });
    return stdout.trim().length > 0;
  } catch {
    // If git fails, err on the side of caution — assume dirty.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Branch helpers
// ---------------------------------------------------------------------------

/** Returns the current branch name, or null if not in a git repo. */
export async function currentBranch(cwd: string, signal?: AbortSignal): Promise<string | null> {
  return tryExec("git branch --show-current", { cwd, timeout: 5_000, signal });
}

/**
 * Returns true if the current branch has an upstream tracking branch set.
 * Async — uses execAsync under the hood.
 */
export async function hasUpstream(cwd: string, signal?: AbortSignal): Promise<boolean> {
  // Non-zero exit means no upstream is configured for this branch.
  return execSucceeds("git rev-parse --abbrev-ref --symbolic-full-name @{u}", {
    cwd,
    timeout: 5_000,
    signal,
  });
}
