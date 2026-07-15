/**
 * logic.ts — pure helpers for fix-ci (no pi imports).
 *
 * Handles git push, polling GitHub checks, and fetching failure logs via `gh`.
 *
 * All shell commands use async exec to avoid blocking the Node event loop
 * (which freezes the TUI). The abort signal is threaded through so Ctrl+C
 * kills child processes promptly.
 */
import { execAsync, execSucceeds, extractErrorOutput, tryExec } from "./exec-async.ts";
import { hasUpstream, currentBranch } from "./git-utils.ts";
import { shellQuote } from "./shell-quote.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  state: string; // SUCCESS, FAILURE, PENDING, IN_PROGRESS, SKIPPED, etc.
  bucket: string; // pass, fail, pending, skipping, cancel
  link: string | null;
}

interface PollResult {
  checks: CheckResult[];
  timedOut: boolean;
  polls: number;
}

interface PollTarget {
  sha: string;
  mode: string;
}

export interface FailureLog {
  name: string;
  link: string | null;
  runId: string | null;
  log: string | null;
}

interface PushResult {
  success: boolean;
  output: string;
}

interface MergeResult {
  success: boolean;
  output: string;
  conflictPaths: string[];
}

// ---------------------------------------------------------------------------
// Git push
// ---------------------------------------------------------------------------

export async function gitPush(cwd: string, signal?: AbortSignal): Promise<PushResult> {
  // A brand-new branch has no upstream, so a bare `git push` fails. In that
  // case push and set the upstream in one go so first pushes succeed.
  const command = (await hasUpstream(cwd, signal)) ? "git push" : "git push -u origin HEAD";

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60_000,
      signal,
    });
    return { success: true, output: stdout + stderr };
  } catch (err: unknown) {
    return { success: false, output: extractErrorOutput(err) };
  }
}

// ---------------------------------------------------------------------------
// Check mode detection
// ---------------------------------------------------------------------------

/** Fetches `branch` from origin. Callers only care about success/failure, not the output. */
async function fetchBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<void> {
  await execAsync(`git fetch origin ${shellQuote(branch)} 2>&1`, {
    cwd,
    timeout: 30_000,
    signal,
  });
}

const GH_DEFAULT_BRANCH_QUERY =
  "gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null";
const GH_PR_BASE_BRANCH_QUERY = "gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null";

/**
 * Detect the repo's default branch (e.g. "main") via `gh`, falling back to
 * "main" if the lookup fails or `gh` isn't available.
 */
async function getDefaultBranch(cwd: string, signal?: AbortSignal): Promise<string> {
  const branch = await tryExec(GH_DEFAULT_BRANCH_QUERY, { cwd, timeout: 10_000, signal });
  return branch ?? "main";
}

export async function detectPrNumber(cwd: string, signal?: AbortSignal): Promise<number | null> {
  const stdout = await tryExec(
    'gh pr view --json number,state --jq \'select(.state != "CLOSED" and .state != "MERGED") | .number\' 2>/dev/null',
    { cwd, timeout: 15_000, signal },
  );
  const num = stdout ? parseInt(stdout, 10) : NaN;
  return isNaN(num) ? null : num;
}

/**
 * Get the state of the current branch's PR (OPEN, CLOSED, MERGED).
 * Returns null if there is no PR for the current branch.
 */
export async function getPrState(cwd: string, signal?: AbortSignal): Promise<string | null> {
  return tryExec("gh pr view --json state --jq '.state' 2>/dev/null", {
    cwd,
    timeout: 15_000,
    signal,
  });
}

export async function getHeadSha(cwd: string, signal?: AbortSignal): Promise<string | null> {
  return tryExec("git rev-parse HEAD", { cwd, timeout: 5_000, signal });
}

/**
 * Returns true if `cwd`'s HEAD needs pushing (or the branch doesn't exist on
 * remote yet). Compares local HEAD SHA against the remote branch SHA via
 * `git ls-remote`, ignoring local tracking config, and fails open (assumes a
 * push is needed) on error since the caller uses this to decide whether to
 * attempt a push at all.
 *
 * This one gates an actual push, so it compares against the remote SHA
 * directly and fails open rather than trusting local tracking config.
 */
export async function needsPush(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const branch = await currentBranch(cwd, signal);
    if (!branch) return true;
    const { stdout: localSha } = await execAsync("git rev-parse HEAD", {
      cwd,
      timeout: 5_000,
      signal,
    });
    const { stdout: remoteSha } = await execAsync(`git ls-remote origin ${shellQuote(branch)}`, {
      cwd,
      timeout: 10_000,
      signal,
    });

    // ls-remote returns empty if branch doesn't exist on remote yet.
    if (!remoteSha.trim()) return true;

    // Format: "<sha>\trefs/heads/<branch>"
    const remoteHead = remoteSha.split("\t")[0];
    return localSha.trim() !== remoteHead;
  } catch {
    // If anything fails, assume there's something to push.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

const MAX_POLLS = 360;
const POLL_INTERVAL_SHORT_MS = 10_000;
const POLL_INTERVAL_LONG_MS = 30_000;
const SHORT_PHASE_POLLS = 12;
const EMPTY_GRACE_POLLS = 4;

function isPending(state: string): boolean {
  return state === "PENDING" || state === "IN_PROGRESS";
}

export function isFailure(bucket: string): boolean {
  return bucket === "fail" || bucket === "cancel";
}

export function mapCheckRun(
  status: string,
  conclusion: string | null,
): { state: string; bucket: string } {
  if (status === "completed") {
    switch (conclusion) {
      case "success":
        return { state: "SUCCESS", bucket: "pass" };
      case "skipped":
      case "neutral":
        return { state: "SKIPPED", bucket: "skipping" };
      case "cancelled":
        return { state: "CANCELLED", bucket: "cancel" };
      default:
        return { state: "FAILURE", bucket: "fail" };
    }
  }
  if (status === "in_progress") return { state: "IN_PROGRESS", bucket: "pending" };
  return { state: "PENDING", bucket: "pending" };
}

export function mapStatusState(state: string): {
  state: string;
  bucket: string;
} {
  switch (state) {
    case "success":
      return { state: "SUCCESS", bucket: "pass" };
    case "pending":
      return { state: "PENDING", bucket: "pending" };
    default:
      return { state: "FAILURE", bucket: "fail" };
  }
}

export function allSuitesComplete(suiteStatuses: string[]): boolean {
  return suiteStatuses.every((s) => s === "completed");
}

async function resolvePollTarget(
  cwd: string,
  signal?: AbortSignal,
  pushedSha?: string,
): Promise<PollTarget> {
  const sha = pushedSha || (await getHeadSha(cwd, signal)) || "";
  const pr = await detectPrNumber(cwd, signal);
  const mode = pr
    ? `PR #${pr} (${sha.slice(0, 8)})`
    : sha
      ? `commit ${sha.slice(0, 8)}`
      : "unknown";
  return { sha, mode };
}

export async function pollChecks(
  cwd: string,
  signal?: AbortSignal,
  onStatus?: (msg: string) => void,
  pushedSha?: string,
): Promise<PollResult & { mode: string }> {
  const { sha, mode } = await resolvePollTarget(cwd, signal, pushedSha);

  onStatus?.(`Checking CI for ${mode}…`);

  if (!sha) {
    return { checks: [], timedOut: false, polls: 0, mode };
  }

  let polls = 0;
  let emptyPolls = 0;
  let settlingPolls = 0;
  let allChecksCompletedOnce = false;

  while (polls < MAX_POLLS) {
    if (signal?.aborted) {
      return {
        checks: await getChecksForSha(sha, cwd, signal),
        timedOut: true,
        polls,
        mode,
      };
    }

    polls++;
    const checks = await getChecksForSha(sha, cwd, signal);
    const suites = await getSuiteStatuses(sha, cwd, signal);
    const suitesComplete = allSuitesComplete(suites);

    const pending = checks.filter((c) => isPending(c.state)).length;
    const total = checks.length;

    if (total === 0) {
      if (suitesComplete) emptyPolls++;
      else emptyPolls = 0;

      if (suitesComplete && emptyPolls >= EMPTY_GRACE_POLLS) {
        onStatus?.(`No checks were registered for ${mode}.`);
        return { checks, timedOut: false, polls, mode };
      }
      onStatus?.(`Poll ${polls}: no checks registered yet for ${mode}, waiting…`);
    } else {
      emptyPolls = 0;
      if (pending === 0 && suitesComplete) {
        onStatus?.(`All ${total} checks finished for ${mode}.`);
        return { checks, timedOut: false, polls, mode };
      }
      // Track if we've ever seen all checks complete to avoid API blips resetting progress
      if (pending === 0) {
        allChecksCompletedOnce = true;
      }
      // Once all checks have completed at least once, start settling grace period
      if (allChecksCompletedOnce && !suitesComplete) {
        settlingPolls++;
        if (settlingPolls >= EMPTY_GRACE_POLLS) {
          onStatus?.(
            `All ${total} checks finished for ${mode} (suites never fully settled, proceeding).`,
          );
          return { checks, timedOut: false, polls, mode };
        }
      }
      const note = suitesComplete ? "" : " (suites still settling)";
      onStatus?.(
        `Poll ${polls}: ${total - pending}/${total} checks finished for ${mode}, ${pending} still running${note}…`,
      );
    }

    const interval = polls <= SHORT_PHASE_POLLS ? POLL_INTERVAL_SHORT_MS : POLL_INTERVAL_LONG_MS;
    await sleep(interval, signal);
  }

  return {
    checks: await getChecksForSha(sha, cwd, signal),
    timedOut: true,
    polls,
    mode,
  };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function ghApi(
  endpoint: string,
  jq: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await execAsync(`gh api --paginate ${shellQuote(endpoint)} --jq '${jq}'`, {
      cwd,
      timeout: 20_000,
      signal,
    });
    return stdout;
  } catch {
    return "";
  }
}

async function getChecksForSha(
  sha: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const runsTsv = await ghApi(
    `repos/{owner}/{repo}/commits/${sha}/check-runs`,
    `.check_runs[] | [.name, .status, (.conclusion // ""), (.html_url // "")] | @tsv`,
    cwd,
    signal,
  );
  for (const line of runsTsv.split("\n")) {
    if (!line.trim()) continue;
    const [name, status, conclusion, url] = line.split("\t");
    const { state, bucket } = mapCheckRun(status ?? "queued", conclusion ? conclusion : null);
    results.push({
      name: name ?? "unknown",
      state,
      bucket,
      link: url ? url : null,
    });
  }

  const statusTsv = await ghApi(
    `repos/{owner}/{repo}/commits/${sha}/status`,
    `.statuses[] | [.context, .state, (.target_url // "")] | @tsv`,
    cwd,
    signal,
  );
  for (const line of statusTsv.split("\n")) {
    if (!line.trim()) continue;
    const [name, state, url] = line.split("\t");
    const mapped = mapStatusState(state ?? "pending");
    results.push({
      name: name ?? "unknown",
      state: mapped.state,
      bucket: mapped.bucket,
      link: url ? url : null,
    });
  }

  return results;
}

async function getSuiteStatuses(sha: string, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const raw = await ghApi(
    `repos/{owner}/{repo}/commits/${sha}/check-suites`,
    `.check_suites[] | .status`,
    cwd,
    signal,
  );
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Failure log fetching
// ---------------------------------------------------------------------------

export async function fetchFailureLogs(
  failures: CheckResult[],
  cwd: string,
  signal?: AbortSignal,
): Promise<FailureLog[]> {
  const results: FailureLog[] = [];
  const seenRunIds = new Set<string>();

  for (const check of failures) {
    if (signal?.aborted) break;

    const runId = extractRunId(check.link);

    if (runId && seenRunIds.has(runId)) {
      results.push({
        name: check.name,
        link: check.link,
        runId,
        log: "(see logs above — same workflow run)",
      });
      continue;
    }

    if (runId) seenRunIds.add(runId);

    const log = runId ? await fetchRunLog(runId, cwd, signal) : null;
    results.push({
      name: check.name,
      link: check.link,
      runId,
      log,
    });
  }

  return results;
}

export function extractRunId(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/\/actions\/runs\/(\d+)/);
  return match?.[1] ?? null;
}

async function fetchRunLog(
  runId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // Try --log-failed first (focused output)
  try {
    const { stdout } = await execAsync(`gh run view ${runId} --log-failed 2>&1`, {
      cwd,
      timeout: 30_000,
      signal,
    });
    if (stdout.trim().length > 0) {
      return trimLog(stdout, 200);
    }
  } catch {
    // may exit non-zero or produce nothing
  }

  // Fall back to full log
  try {
    const { stdout } = await execAsync(`gh run view ${runId} --log 2>&1`, {
      cwd,
      timeout: 30_000,
      signal,
    });
    return trimLog(stdout, 300);
  } catch {
    return null;
  }
}

export function trimLog(log: string, maxLines: number): string {
  const lines = log.split("\n");
  if (lines.length <= maxLines) return log;
  return `… (${lines.length - maxLines} lines trimmed) …\n` + lines.slice(-maxLines).join("\n");
}

// ---------------------------------------------------------------------------
// PR conflict detection & resolution
// ---------------------------------------------------------------------------

/**
 * Get the base branch name of the current PR (e.g. "main").
 * Returns null if there's no PR or the query fails.
 */
export async function getPrBaseBranch(cwd: string, signal?: AbortSignal): Promise<string | null> {
  // Try to get the base branch from an existing PR first.
  const baseFromPr = await tryExec(GH_PR_BASE_BRANCH_QUERY, { cwd, timeout: 15_000, signal });
  if (baseFromPr) return baseFromPr;

  // Fall back to the repo's default branch (e.g. "main") when no PR exists.
  // This ensures the base-branch-ahead check runs even on the first push.
  return tryExec(GH_DEFAULT_BRANCH_QUERY, { cwd, timeout: 15_000, signal });
}

/**
 * Get the latest commit SHA of a branch via the GitHub API.
 * Returns null on failure.
 */
async function getBranchShaViaApi(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return tryExec(
    `gh api ${shellQuote(`repos/{owner}/{repo}/git/ref/heads/${branch}`)} --jq '.object.sha' 2>/dev/null`,
    { cwd, timeout: 15_000, signal },
  );
}

/**
 * Merge the latest version of the base branch into the current PR branch.
 *
 * 1. Creates a worktree with the base branch checked out at its latest SHA
 * 2. Verifies the worktree SHA matches what the GitHub API reports
 * 3. Merges the base branch into the current branch (creates a merge commit
 *    if no conflicts, stops with conflicts if there are any)
 *
 * Returns { success, output, conflictPaths }.
 */
export async function mergeBaseBranchIntoCurrent(
  cwd: string,
  baseBranch: string,
  branch: string,
  signal?: AbortSignal,
): Promise<MergeResult> {
  const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
  const worktreePath = `/tmp/vt-pi-merge-${safeBranch}-${Date.now()}`;

  // Helper to clean up the worktree (best-effort).
  const removeWorktree = async () => {
    try {
      await execAsync(`git worktree remove ${worktreePath} --force 2>/dev/null`, {
        cwd,
        timeout: 10_000,
        signal,
      });
    } catch {
      // Best-effort cleanup — ignore failures.
    }
  };

  try {
    // Step 1: Fetch the latest base branch from origin
    await fetchBranch(cwd, baseBranch, signal);

    // Step 2: Create a worktree with the base branch checked out
    await execAsync(`git worktree add ${worktreePath} ${shellQuote(`origin/${baseBranch}`)} 2>&1`, {
      cwd,
      timeout: 30_000,
      signal,
    });

    // Step 3: Verify the worktree's HEAD matches what GitHub says
    const expectedSha = await getBranchShaViaApi(cwd, baseBranch, signal);
    if (expectedSha) {
      const { stdout: actualSha } = await execAsync("git rev-parse HEAD", {
        cwd: worktreePath,
        timeout: 5_000,
        signal,
      });
      if (actualSha.trim() !== expectedSha) {
        // Force-update the local branch ref to match GitHub
        await execAsync(
          `git fetch origin ${shellQuote(`${baseBranch}:${baseBranch}`)} --force 2>&1`,
          { cwd, timeout: 30_000, signal },
        );
        await removeWorktree();
        await execAsync(`git worktree add ${worktreePath} ${shellQuote(baseBranch)} 2>&1`, {
          cwd,
          timeout: 30_000,
          signal,
        });
      }
    }

    // Step 4: Get the SHA to merge from (use the worktree's HEAD)
    const { stdout: baseSha } = await execAsync("git rev-parse HEAD", {
      cwd: worktreePath,
      timeout: 5_000,
      signal,
    });
    const sha = baseSha.trim();

    // Step 5: Merge the base branch into the current PR branch
    // `git merge` performs a merge (not a rebase), creating a merge commit
    // on success. On conflicts it stops and lets the user resolve.
    try {
      const { stdout, stderr } = await execAsync(`git merge ${sha} --no-edit 2>&1`, {
        cwd,
        timeout: 30_000,
        signal,
      });
      await removeWorktree();
      return { success: true, output: stdout + stderr, conflictPaths: [] };
    } catch (mergeErr: unknown) {
      const output = extractErrorOutput(mergeErr);
      const conflictPaths = extractConflictPaths(output);
      await removeWorktree();
      return { success: false, output, conflictPaths };
    }
  } catch (err: unknown) {
    await removeWorktree();
    return { success: false, output: extractErrorOutput(err), conflictPaths: [] };
  }
}

/**
 * Parse git merge output to extract paths of files with conflicts.
 */
function extractConflictPaths(output: string): string[] {
  const paths: string[] = [];
  const regex = /CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(\S+)/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    if (!paths.includes(match[1])) {
      paths.push(match[1]);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Remote-ahead detection & pull
// ---------------------------------------------------------------------------

/**
 * Check if the remote tracking branch can't be fast-forwarded into the local
 * branch — meaning we need to pull remote changes before pushing.
 *
 * Uses `git merge-base --is-ancestor` which correctly handles both "remote is
 * ahead" and "histories diverged" (e.g. after a rebase). Returns true when a
 * plain push would fail (remote has commits local doesn't, or histories have
 * diverged entirely).
 *
 * Fetches first to ensure refs are up to date.
 */
export async function needsPullBeforePush(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const branch = await currentBranch(cwd, signal);
    if (!branch) return false;

    // Fetch the latest remote refs for this branch
    await fetchBranch(cwd, branch, signal);

    // origin/<branch> is an ancestor of HEAD → can fast-forward push → no pull
    // needed (exit 0). If NOT an ancestor, remote is ahead or histories
    // diverged (non-zero) → pull needed.
    const isAncestor = await execSucceeds(
      `git merge-base --is-ancestor ${shellQuote(`origin/${branch}`)} HEAD 2>/dev/null`,
      { cwd, timeout: 10_000, signal },
    );
    return !isAncestor;
  } catch {
    return false;
  }
}

/**
 * Pull remote changes into the local branch using merge (not rebase).
 * Uses --no-edit so the merge commit message is auto-generated.
 * Returns { success, output, conflictPaths }.
 */
export async function pullRemoteChanges(cwd: string, signal?: AbortSignal): Promise<MergeResult> {
  try {
    const { stdout, stderr } = await execAsync("git pull --no-rebase --no-edit 2>&1", {
      cwd,
      timeout: 30_000,
      signal,
    });
    return { success: true, output: stdout + stderr, conflictPaths: [] };
  } catch (err: unknown) {
    const output = extractErrorOutput(err);
    const conflictPaths = extractConflictPaths(output);
    return { success: false, output, conflictPaths };
  }
}

// ---------------------------------------------------------------------------
// Base branch ahead detection
// ---------------------------------------------------------------------------

/**
 * Check if the PR's base branch has commits ahead of the current branch.
 * Fetches the latest base branch ref from origin, then counts commits on
 * the base branch that aren't reachable from HEAD.
 *
 * Returns true if the base branch has newer commits that should be merged
 * into the current branch before pushing.
 */
export async function isBaseBranchAhead(
  cwd: string,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    // Fetch the latest base branch ref from origin
    await fetchBranch(cwd, baseBranch, signal);

    // Count commits on origin/<base> that aren't reachable from HEAD.
    // If > 0, the base branch has commits ahead of the current branch.
    const { stdout } = await execAsync(
      `git rev-list --count ${shellQuote(`HEAD..origin/${baseBranch}`)} 2>/dev/null`,
      { cwd, timeout: 10_000, signal },
    );
    const count = parseInt(stdout.trim(), 10);
    return !isNaN(count) && count > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// PR lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Generate a PR title from the current branch name.
 * Strips the vt_ prefix, replaces separators with spaces, capitalizes first letter.
 */
export async function generatePrTitle(cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    let branch = await currentBranch(cwd, signal);
    if (!branch) return "Changes from push_and_check_ci";

    // Remove vt_ prefix if present.
    if (branch.startsWith("vt_")) {
      branch = branch.slice(3);
    }

    // Replace separators (-, _, /, .) with spaces.
    branch = branch.replace(/[-_\/.]/g, " ");

    // Collapse multiple spaces.
    branch = branch.replace(/\s+/g, " ");

    // Capitalize first letter.
    if (branch.length > 0) {
      branch = branch[0].toUpperCase() + branch.slice(1);
    }

    return branch || "Changes from push_and_check_ci";
  } catch {
    return "Changes from push_and_check_ci";
  }
}

/**
 * Generate a PR body from commit messages since branch divergence.
 * Returns a formatted markdown string with commit list and description.
 */
export async function generatePrBody(cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    // Determine the repo's default branch, then find the fork point.
    let base: string;
    try {
      const defaultBranch = await getDefaultBranch(cwd, signal);

      // Fetch the latest base branch ref so merge-base is accurate.
      await fetchBranch(cwd, defaultBranch, signal);

      const { stdout: mergeBase } = await execAsync(
        `git merge-base HEAD ${shellQuote(`origin/${defaultBranch}`)} 2>/dev/null || echo HEAD~1`,
        { cwd, timeout: 10_000, signal },
      );
      base = mergeBase.trim();
    } catch {
      base = "HEAD~1";
    }

    const { stdout: log } = await execAsync(`git log --oneline ${base}..HEAD`, {
      cwd,
      timeout: 10_000,
      signal,
    });
    const commits = log.trim().split("\n").filter(Boolean);

    if (commits.length === 0) {
      return "No commit messages available.";
    }

    let body = "## Changes\n\n";
    for (const c of commits) {
      // Strip the SHA prefix (e.g., "abc1234 Fix thing" → "Fix thing").
      const msg = c.replace(/^[0-9a-f]{7,9}\s*/, "");
      body += `- ${msg}\n`;
    }
    body += `\nAuto-generated from ${commits.length} commit(s) on this branch.`;
    return body;
  } catch {
    return "Changes on this branch.";
  }
}

/**
 * Create a draft pull request for the current branch.
 * Returns { success, url } or { success: false, error }.
 */
export async function createDraftPr(
  cwd: string,
  title: string,
  body: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; url: string | null; output: string }> {
  try {
    // Get the current branch name to pass explicitly via --head.
    const head = await currentBranch(cwd, signal);
    if (!head) return { success: false, url: null, output: "Could not determine current branch." };

    // Detect the default base branch via gh.
    const base = await getDefaultBranch(cwd, signal);

    const { stdout, stderr } = await execAsync(
      `gh pr create --draft --title ${shellQuote(title)} --body ${shellQuote(body)} --head ${shellQuote(head)} --base ${shellQuote(base)}`,
      { cwd, timeout: 30_000, signal },
    );
    return { success: true, url: stdout.trim() || null, output: stdout + stderr };
  } catch (err: unknown) {
    return { success: false, url: null, output: extractErrorOutput(err) };
  }
}

/**
 * Mark the current PR as ready for review (convert from draft).
 * Returns true on success.
 */
export async function markPrReady(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await execAsync("gh pr ready", { cwd, timeout: 15_000, signal });
    return true;
  } catch {
    return false;
  }
}

/**
 * Add reviewers to the current PR.
 * `reviewers` is a space-separated list of GitHub usernames.
 */
export async function addReviewers(
  cwd: string,
  reviewers: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await execAsync(`gh pr edit --add-reviewer ${shellQuote(reviewers)}`, {
      cwd,
      timeout: 15_000,
      signal,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Review types
// ---------------------------------------------------------------------------

export interface Review {
  id: number;
  author: string;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  body: string;
  submittedAt: string;
  commitId: string | null; // SHA the review was submitted against; null if unknown
}

interface ReviewComment {
  id: number;
  pullRequestReviewId: number;
  path: string;
  line: number | null;
  startLine: number | null; // start of a multi-line comment range; null for single-line comments
  body: string;
  author: string;
}

export interface ReviewResult {
  decision: "approved" | "changes_requested" | "pending" | "timeout";
  reviews: Review[];
  comments: ReviewComment[]; // only from the most recent CHANGES_REQUESTED review
  reviewer: string | null;
  reviewBody: string;
}

// ---------------------------------------------------------------------------
// Review fetching
// ---------------------------------------------------------------------------

/** Shape of one entry in `gh api .../pulls/{n}/reviews` output that we care about. */
interface RawReview {
  id: number;
  author?: { login: string };
  user?: { login: string };
  state?: string;
  body?: string;
  submitted_at?: string;
  commit_id?: string;
}

/**
 * Map raw `gh api` review JSON into Review objects.
 *
 * Pulled out from fetchPrReviews so the mapping is unit-testable without
 * mocking `gh` — mirroring parseReviewComments. The `author ?? user` login
 * fallback is the reason this matters: `gh api` (REST) returns the reviewer
 * under `.user`, while `gh pr view`-style (GraphQL) output uses `.author`;
 * getting that wrong silently labels every reviewer "unknown", which then
 * breaks re-request-review and the changes-requested attribution downstream.
 */
export function parseReviews(raw: unknown): Review[] {
  const reviews = raw as RawReview[];
  return (Array.isArray(reviews) ? reviews : []).map((r) => ({
    id: r.id,
    author: (r.author ?? r.user)?.login ?? "unknown",
    state: r.state ?? "UNKNOWN",
    body: r.body ?? "",
    submittedAt: r.submitted_at ?? "",
    commitId: r.commit_id ?? null,
  }));
}

async function fetchPrReviews(
  cwd: string,
  prNumber: number | null,
  signal?: AbortSignal,
): Promise<Review[]> {
  if (!prNumber) return [];
  try {
    const { stdout } = await execAsync(
      `gh api --paginate repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
      { cwd, timeout: 15_000, signal },
    );
    if (!stdout.trim()) return [];
    return parseReviews(JSON.parse(stdout.trim()));
  } catch {
    return [];
  }
}

/** Shape of one entry in `gh api .../reviews/{id}/comments` output that we care about. */
interface RawReviewComment {
  id: number;
  path?: string;
  line?: number;
  start_line?: number;
  body?: string;
  user?: { login: string };
}

/**
 * Map raw `gh api` review-comment JSON into ReviewComment objects.
 * Pulled out from fetchCommentsForReview so the mapping is unit-testable
 * without mocking `gh`.
 */
export function parseReviewComments(raw: unknown, reviewId: number): ReviewComment[] {
  const comments = raw as RawReviewComment[];
  return (Array.isArray(comments) ? comments : []).map((c) => ({
    id: c.id,
    pullRequestReviewId: reviewId,
    path: c.path ?? "",
    line: c.line ?? null,
    startLine: c.start_line ?? null,
    body: c.body ?? "",
    author: c.user?.login ?? "unknown",
  }));
}

async function fetchCommentsForReview(
  cwd: string,
  prNumber: number | null,
  reviewId: number,
  signal?: AbortSignal,
): Promise<ReviewComment[]> {
  if (!prNumber) return [];
  try {
    const { stdout } = await execAsync(
      `gh api --paginate repos/{owner}/{repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
      { cwd, timeout: 15_000, signal },
    );
    if (!stdout.trim()) return [];
    const raw = JSON.parse(stdout.trim());
    return parseReviewComments(raw, reviewId);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Re-request review from previous changes-requested reviewer
// ---------------------------------------------------------------------------

/**
 * Find the reviewer who most recently requested changes on the PR.
 *
 * Only considers reviews that are NOT against the current HEAD — these are
 * the reviews whose feedback we're now addressing with new commits.
 * Returns null if no such review exists (e.g. first push, or already approved).
 */
export async function getLatestChangesRequestedReviewer(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const prNumber = await detectPrNumber(cwd, signal);
  if (!prNumber) return null;

  const headSha = (await getHeadSha(cwd, signal))?.trim() ?? "";

  const reviews = await fetchPrReviews(cwd, prNumber, signal);

  // Find the most recent CHANGES_REQUESTED review that is NOT against the
  // current HEAD (i.e. it was submitted before our latest push). Reviews
  // against the current HEAD are new — not something we're fixing.
  const staleChangesRequested = reviews
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .filter((r) => r.commitId && r.commitId !== headSha)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  if (staleChangesRequested.length === 0) return null;

  return staleChangesRequested[0].author;
}

// ---------------------------------------------------------------------------
// Review polling
// ---------------------------------------------------------------------------

export const MAX_REVIEW_POLLS = 120; // 120 * 30s = 60 minutes
const REVIEW_POLL_INTERVAL_MS = 30_000;

/**
 * Pick the review that decides the PR's outcome from the currently-active
 * reviews (already narrowed to the current HEAD, with DISMISSED removed), or
 * null when no decision has been reached yet.
 *
 * Mirrors how GitHub itself derives a PR's review decision: only APPROVED and
 * CHANGES_REQUESTED reviews are decisive — a COMMENTED or PENDING review never
 * changes the outcome, so a reviewer who approves (or requests changes) and
 * then leaves a plain follow-up comment is still approving (or still blocking).
 * Taking the single latest review by timestamp, as this used to, let that
 * trailing comment mask the decision and stall the poll until it timed out.
 *
 * Each reviewer's *latest* decisive review is what counts (an earlier one they
 * superseded is ignored). If any reviewer's current stance is CHANGES_REQUESTED
 * the PR is blocked, so that wins over approvals; otherwise the most recent
 * approval is returned.
 */
export function decisiveReview(active: Review[]): Review | null {
  const latestByAuthor = new Map<string, Review>();
  for (const r of active) {
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
    const prev = latestByAuthor.get(r.author);
    if (!prev || r.submittedAt > prev.submittedAt) latestByAuthor.set(r.author, r);
  }

  const decisive = [...latestByAuthor.values()];
  if (decisive.length === 0) return null;

  const blocking = decisive.filter((r) => r.state === "CHANGES_REQUESTED");
  const pool = blocking.length > 0 ? blocking : decisive;
  return pool.reduce((a, b) => (a.submittedAt > b.submittedAt ? a : b));
}

/**
 * Poll for PR reviews until a decision is reached (approved or changes
 * requested). Times out after MAX_REVIEW_POLLS polls.
 *
 * Reviews submitted against an older commit (before the current HEAD) are
 * treated as stale and ignored — only reviews against the current HEAD are
 * considered active.
 *
 * - APPROVED → returns immediately
 * - CHANGES_REQUESTED → fetches inline comments linked to that review
 * - COMMENTED (no decision yet) → logs via onStatus, keeps polling
 * - PENDING / no active reviews → logs via onStatus, keeps polling
 */
export async function waitForReview(
  cwd: string,
  signal?: AbortSignal,
  onStatus?: (msg: string) => void,
): Promise<ReviewResult> {
  let polls = 0;

  // Capture the PR's HEAD SHA at the start. Reviews submitted against
  // an older commit (before new pushes) are stale and should be ignored.
  const headSha = ((await getHeadSha(cwd, signal)) ?? "").trim();
  const prNumber = await detectPrNumber(cwd, signal);

  while (polls < MAX_REVIEW_POLLS) {
    if (signal?.aborted) {
      return { decision: "pending", reviews: [], comments: [], reviewer: null, reviewBody: "" };
    }

    polls++;

    const reviews = await fetchPrReviews(cwd, prNumber, signal);
    // Filter out DISMISSED and stale reviews (submitted against an older commit).
    const active = reviews.filter((r) => {
      if (r.state === "DISMISSED") return false;
      if (headSha && r.commitId && r.commitId !== headSha) return false;
      return true;
    });

    if (active.length === 0) {
      onStatus?.(`Poll ${polls}/${MAX_REVIEW_POLLS}: awaiting reviewer assignment…`);
      await sleep(REVIEW_POLL_INTERVAL_MS, signal);
      continue;
    }

    // A decisive review (approval / changes requested) settles the outcome
    // even if a later COMMENTED/PENDING review exists — those never change a
    // PR's decision on GitHub, so they must not mask an earlier one here.
    const decisive = decisiveReview(active);

    if (decisive?.state === "APPROVED") {
      onStatus?.(`PR approved by @${decisive.author}.`);
      return {
        decision: "approved",
        reviews,
        comments: [],
        reviewer: decisive.author,
        reviewBody: decisive.body,
      };
    }
    if (decisive?.state === "CHANGES_REQUESTED") {
      onStatus?.(`Changes requested by @${decisive.author}. Fetching review comments…`);
      // Fetch comments linked to this specific review directly.
      const linkedComments = await fetchCommentsForReview(cwd, prNumber, decisive.id, signal);
      return {
        decision: "changes_requested",
        reviews,
        comments: linkedComments,
        reviewer: decisive.author,
        reviewBody: decisive.body,
      };
    }

    // No decision yet — report the most recent active review's status and
    // keep polling.
    const latest = active.reduce((a, b) => (a.submittedAt > b.submittedAt ? a : b));

    switch (latest.state) {
      case "COMMENTED": {
        const bodyPreview = latest.body
          ? ` — "${latest.body.slice(0, 80)}${latest.body.length > 80 ? "…" : ""}"`
          : "";
        onStatus?.(
          `Poll ${polls}/${MAX_REVIEW_POLLS}: @${latest.author} commented${bodyPreview} — awaiting decision…`,
        );
        break;
      }
      case "PENDING": {
        onStatus?.(`Poll ${polls}/${MAX_REVIEW_POLLS}: @${latest.author} is reviewing (pending)…`);
        break;
      }
      default: {
        onStatus?.(
          `Poll ${polls}/${MAX_REVIEW_POLLS}: review state is "${latest.state}" — waiting…`,
        );
      }
    }

    await sleep(REVIEW_POLL_INTERVAL_MS, signal);
  }

  return {
    decision: "timeout",
    reviews: [],
    comments: [],
    reviewer: null,
    reviewBody: "",
  };
}
