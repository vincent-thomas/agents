import { type CheckResult, type FailureLog } from "./logic.ts";

export interface StackPullRequest {
  number: number;
  state: string;
  isDraft: boolean;
  headRefOid: string;
}

export interface StackBranchResolution {
  sha: string | null;
  pr: StackPullRequest | null;
}

export interface StackBranchReport {
  branch: string;
  sha: string | null;
  prNumber: number | null;
  prState: string | null;
  prHeadRefOid: string | null;
  isDraft: boolean | null;
  checks: CheckResult[];
  timedOut: boolean;
  polls: number;
  mode: string;
  failureLogs: FailureLog[];
  reason?: string;
  ready: boolean | null;
}

export interface StackReadinessResult {
  allChecksPassed: boolean;
  allReady: boolean;
  branches: StackBranchReport[];
}

export interface StackReadinessDependencies {
  resolveBranch: (
    cwd: string,
    branch: string,
    signal?: AbortSignal,
  ) => Promise<StackBranchResolution>;
  pollChecks: (
    cwd: string,
    signal: AbortSignal | undefined,
    onStatus: ((message: string) => void) | undefined,
    sha: string,
  ) => Promise<{
    checks: CheckResult[];
    timedOut: boolean;
    polls: number;
    mode: string;
  }>;
  fetchFailureLogs: (
    failures: CheckResult[],
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<FailureLog[]>;
  markPrReady: (cwd: string, signal: AbortSignal | undefined, branch: string) => Promise<boolean>;
}

export type StackReadinessRunner = (
  cwd: string,
  branches: readonly string[],
  signal: AbortSignal | undefined,
  onStatus: (message: string) => void,
  dependencies: StackReadinessDependencies,
) => Promise<StackReadinessResult>;

function addReason(report: StackBranchReport, reason: string): void {
  report.reason = report.reason ? `${report.reason}; ${reason}` : reason;
}

function errorDescription(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const description = String(error).trim();
  return description || "unknown error";
}

function unavailableResolution(): StackBranchResolution {
  return { sha: null, pr: null };
}

function rethrowIfAborted(signal: AbortSignal | undefined, error: unknown): void {
  if (signal?.aborted) throw error;
}

async function resolveBranchSafely(
  resolveBranch: StackReadinessDependencies["resolveBranch"],
  cwd: string,
  branch: string,
  signal: AbortSignal | undefined,
): Promise<{ resolution: StackBranchResolution; error: unknown | null }> {
  try {
    signal?.throwIfAborted();
    const resolution = await resolveBranch(cwd, branch, signal);
    signal?.throwIfAborted();
    return { resolution, error: null };
  } catch (error: unknown) {
    rethrowIfAborted(signal, error);
    return { resolution: unavailableResolution(), error };
  }
}

function resolutionMatchesReport(
  report: StackBranchReport,
  resolution: StackBranchResolution,
): boolean {
  const pr = resolution.pr;
  return (
    resolution.sha === report.sha &&
    pr !== null &&
    pr.number === report.prNumber &&
    pr.state === report.prState &&
    pr.isDraft === report.isDraft &&
    pr.headRefOid === report.prHeadRefOid
  );
}

function describeResolutionChange(
  report: StackBranchReport,
  resolution: StackBranchResolution,
): string {
  if (resolution.sha !== report.sha) {
    return `local SHA changed from ${report.sha ?? "missing"} to ${resolution.sha ?? "missing"}`;
  }
  if (!resolution.pr) return "PR resolution changed or the open PR disappeared";
  if (resolution.pr.headRefOid !== report.prHeadRefOid) {
    return `PR head SHA changed from ${report.prHeadRefOid ?? "missing"} to ${resolution.pr.headRefOid}`;
  }
  return "PR metadata changed after polling";
}

/**
 * Resolve and check every branch in a submitted stack before changing any PR
 * state. A branch is polled only when its PR head exactly matches its local
 * branch SHA. Every branch is resolved again after polling, immediately before
 * any ready command, to prevent a concurrent push from producing a partially
 * ready stack.
 */
export const checkAndReadyStack: StackReadinessRunner = async (
  cwd,
  branches,
  signal,
  onStatus,
  dependencies,
): Promise<StackReadinessResult> => {
  const reports: StackBranchReport[] = [];
  const resolutions = await Promise.all(
    branches.map(async (branch) => ({
      branch,
      ...(await resolveBranchSafely(dependencies.resolveBranch, cwd, branch, signal)),
    })),
  );

  for (const { branch, resolution, error } of resolutions) {
    const pr = resolution.pr;
    const report: StackBranchReport = {
      branch,
      sha: resolution.sha,
      prNumber: pr?.number ?? null,
      prState: pr?.state ?? null,
      prHeadRefOid: pr?.headRefOid ?? null,
      isDraft: pr?.isDraft ?? null,
      checks: [],
      timedOut: false,
      polls: 0,
      mode: resolution.sha ? `commit ${resolution.sha.slice(0, 8)}` : "unknown",
      failureLogs: [],
      ready: null,
    };

    if (error) addReason(report, `could not resolve branch: ${errorDescription(error)}`);
    if (!resolution.sha) addReason(report, "missing local SHA");
    if (!pr) {
      addReason(report, "missing open PR");
    } else if (pr.state !== "OPEN") {
      addReason(report, `PR #${pr.number} is ${pr.state}, not OPEN`);
    } else if (pr.headRefOid !== resolution.sha) {
      addReason(
        report,
        `PR #${pr.number} points to SHA ${pr.headRefOid}, not local SHA ${resolution.sha ?? "missing"}`,
      );
    }
    reports.push(report);
  }

  for (const report of reports) {
    // Checks for an older commit cannot establish stack readiness.
    if (!report.sha || report.reason) continue;
    onStatus(`Polling CI for stack branch \`${report.branch}\` at ${report.sha.slice(0, 8)}…`);
    let poll: Awaited<ReturnType<StackReadinessDependencies["pollChecks"]>>;
    try {
      signal?.throwIfAborted();
      poll = await dependencies.pollChecks(cwd, signal, undefined, report.sha);
      signal?.throwIfAborted();
    } catch (error: unknown) {
      rethrowIfAborted(signal, error);
      addReason(report, `could not poll checks: ${errorDescription(error)}`);
      continue;
    }
    report.checks = poll.checks;
    report.timedOut = poll.timedOut;
    report.polls = poll.polls;
    report.mode = poll.mode;

    const nonPassing = poll.checks.filter((check) => check.bucket !== "pass");
    const failures = poll.checks.filter(
      (check) => check.bucket === "fail" || check.bucket === "cancel",
    );
    if (failures.length > 0) {
      try {
        signal?.throwIfAborted();
        report.failureLogs = await dependencies.fetchFailureLogs(failures, cwd, signal);
        signal?.throwIfAborted();
      } catch (error: unknown) {
        rethrowIfAborted(signal, error);
        addReason(report, `could not fetch failure logs: ${errorDescription(error)}`);
      }
    }
    if (nonPassing.length > 0) {
      addReason(
        report,
        `${nonPassing.length} non-passing check${nonPassing.length === 1 ? "" : "s"}`,
      );
    }
    if (poll.timedOut) {
      addReason(report, `checks timed out after ${poll.polls} polls`);
    } else if (poll.checks.length === 0) {
      addReason(report, "no checks ran");
    }
  }

  const allChecksPassed = reports.every(
    (report) =>
      !!report.sha &&
      report.prState === "OPEN" &&
      report.prNumber !== null &&
      report.prHeadRefOid === report.sha &&
      report.checks.length > 0 &&
      !report.timedOut &&
      report.checks.every((check) => check.bucket === "pass") &&
      report.reason === undefined,
  );

  if (!allChecksPassed) return { allChecksPassed: false, allReady: false, branches: reports };

  // Re-resolve the complete stack after all checks have finished. A push or PR
  // update during polling invalidates the whole readiness decision.
  const preflight = await Promise.all(
    branches.map(async (branch) => ({
      branch,
      ...(await resolveBranchSafely(dependencies.resolveBranch, cwd, branch, signal)),
    })),
  );
  let stackChanged = false;
  for (const { branch, resolution, error } of preflight) {
    const report = reports.find((candidate) => candidate.branch === branch);
    if (!report || (!error && resolutionMatchesReport(report, resolution))) continue;
    stackChanged = true;
    addReason(
      report,
      `stack changed before ready: ${
        error
          ? `could not resolve branch: ${errorDescription(error)}`
          : describeResolutionChange(report, resolution)
      }`,
    );
  }
  if (stackChanged) return { allChecksPassed: false, allReady: false, branches: reports };

  for (const report of reports) {
    if (!report.isDraft) continue;

    // GitHub's ready transition has no expected-head option. Re-resolve the
    // complete stack as close as possible to each mutation so a concurrent
    // change to an already-ready or later PR also fails closed.
    const immediatePreflight = await Promise.all(
      branches.map(async (branch) => ({
        branch,
        ...(await resolveBranchSafely(dependencies.resolveBranch, cwd, branch, signal)),
      })),
    );
    let changedImmediately = false;
    for (const candidate of immediatePreflight) {
      const candidateReport = reports.find((item) => item.branch === candidate.branch);
      if (
        !candidateReport ||
        (!candidate.error && resolutionMatchesReport(candidateReport, candidate.resolution))
      ) {
        continue;
      }
      changedImmediately = true;
      addReason(
        candidateReport,
        `stack changed immediately before ready: ${
          candidate.error
            ? `could not resolve branch: ${errorDescription(candidate.error)}`
            : describeResolutionChange(candidateReport, candidate.resolution)
        }`,
      );
    }
    if (changedImmediately) {
      return { allChecksPassed: false, allReady: false, branches: reports };
    }

    onStatus(`Marking PR #${report.prNumber} for \`${report.branch}\` ready for review…`);
    try {
      signal?.throwIfAborted();
      report.ready = await dependencies.markPrReady(cwd, signal, report.branch);
      signal?.throwIfAborted();
    } catch (error: unknown) {
      rethrowIfAborted(signal, error);
      report.ready = false;
      addReason(report, `could not mark PR ready: ${errorDescription(error)}`);
    }
    if (report.ready) report.isDraft = false;
  }

  const allReady = reports.every((report) => report.isDraft !== true || report.ready === true);
  return { allChecksPassed: true, allReady, branches: reports };
};
