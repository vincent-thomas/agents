/**
 * Prepare local branch refs for an explicitly described GitHub stack.
 *
 * This module deliberately uses execFile rather than a shell: commit-ish and
 * branch names are supplied by the tool caller. Preparation is transactional
 * for refs created by this operation, so a failed validation or update cannot
 * leave a partial stack behind.
 */
import { execFile } from "node:child_process";

interface GitCommandError extends Error {
  code?: string | number;
  stdout?: string;
  stderr?: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        signal,
        timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        const output = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
        if (error) {
          const commandError = error as GitCommandError;
          commandError.stdout = output.stdout;
          commandError.stderr = output.stderr;
          reject(commandError);
          return;
        }
        resolve(output);
      },
    );
  });
}

function commandErrorOutput(error: unknown): string {
  if (error instanceof Error) {
    const commandError = error as GitCommandError;
    const output = [commandError.stderr, commandError.stdout].filter(Boolean).join("\n");
    return output || commandError.message;
  }
  return String(error);
}

function exitCode(error: unknown): string | number | undefined {
  return error instanceof Error ? (error as GitCommandError).code : undefined;
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

const ZERO_SHA = "0000000000000000000000000000000000000000";

export interface BranchPointsPreparationResult {
  success: boolean;
  output: string;
  createdBranches: string[];
  commits?: string[];
}

function failure(output: string, rollbackOutput = ""): BranchPointsPreparationResult {
  return {
    success: false,
    output: [output, rollbackOutput].filter(Boolean).join("\n"),
    createdBranches: [],
  };
}

async function rollbackRefs(
  cwd: string,
  created: readonly { branch: string; commit: string }[],
): Promise<string> {
  const errors: string[] = [];
  for (const { branch, commit } of [...created].reverse()) {
    try {
      // The expected old value prevents cleanup from deleting a ref changed
      // by another operation after this preparation created it.
      await runGit(["update-ref", branchRef(branch), ZERO_SHA, commit], cwd);
    } catch (error: unknown) {
      errors.push(`Could not roll back local branch \`${branch}\`: ${commandErrorOutput(error)}`);
    }
  }
  return errors.join("\n");
}

async function validateBranchName(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const result = await runGit(["check-ref-format", "--branch", branch], cwd, signal);
    // --branch accepts checkout shorthand such as @{-1}; it is not a literal
    // branch ref, so only accept names which Git reports unchanged.
    if (result.stdout.trim() !== branch) {
      return `\`${branch}\` is not a literal local branch name.`;
    }
    return null;
  } catch (error: unknown) {
    return `\`${branch}\` is not a valid local branch name: ${commandErrorOutput(error)}`;
  }
}

async function resolveCommit(
  cwd: string,
  point: string,
  label: string,
  signal?: AbortSignal,
): Promise<{ commit: string } | { error: string }> {
  try {
    const result = await runGit(
      ["rev-parse", "--verify", "--end-of-options", `${point}^{commit}`],
      cwd,
      signal,
    );
    const commit = result.stdout.trim();
    if (!/^[0-9a-fA-F]{40}$/.test(commit)) {
      return { error: `Could not resolve ${label} \`${point}\` to a commit.` };
    }
    return { commit: commit.toLowerCase() };
  } catch (error: unknown) {
    return {
      error: `Could not resolve ${label} \`${point}\` to a commit: ${commandErrorOutput(error)}`,
    };
  }
}

/**
 * Validate and materialize branch_points without changing the checked-out
 * branch. Existing refs must already point at their requested commits.
 */
export async function prepareBranchPoints(
  cwd: string,
  branches: readonly string[],
  branchPoints: readonly string[],
  currentBranch: string,
  signal?: AbortSignal,
): Promise<BranchPointsPreparationResult> {
  const created: { branch: string; commit: string }[] = [];

  const fail = async (output: string): Promise<BranchPointsPreparationResult> => {
    // Cleanup must still run when the caller's signal caused the preparation
    // failure; forwarding an already-aborted signal would preserve partial refs.
    const rollbackOutput = await rollbackRefs(cwd, created);
    return failure(output, rollbackOutput);
  };

  if (
    branches.length === 0 ||
    branchPoints.length === 0 ||
    branches.length !== branchPoints.length
  ) {
    return failure("`branch_points` must contain one non-empty commit point for every branch.");
  }
  if (branches[branches.length - 1] !== currentBranch) {
    return failure(
      `The final branch must be the owned workspace branch \`${currentBranch}\` when ` +
        "`branch_points` is supplied.",
    );
  }

  const seen = new Set<string>();
  for (const branch of branches) {
    if (seen.has(branch)) {
      return failure(`The stack cannot contain the local branch \`${branch}\` more than once.`);
    }
    seen.add(branch);
    const branchError = await validateBranchName(cwd, branch, signal);
    if (branchError) return fail(branchError);
  }

  const commits: string[] = [];
  for (const [index, point] of branchPoints.entries()) {
    if (point.trim().length === 0) {
      return fail(`Branch point ${index + 1} must be a non-empty commit-ish.`);
    }
    const resolved = await resolveCommit(cwd, point, `branch point ${index + 1}`, signal);
    if ("error" in resolved) return fail(resolved.error);
    commits.push(resolved.commit);
  }

  const head = await resolveCommit(cwd, "HEAD", "HEAD", signal);
  if ("error" in head) return fail(head.error);
  if (commits[commits.length - 1] !== head.commit) {
    return fail(
      `The final branch point must resolve to HEAD (${head.commit}), but it resolves to ${commits[commits.length - 1]}.`,
    );
  }

  for (let index = 1; index < commits.length; index++) {
    if (commits[index - 1] === commits[index]) {
      return fail(`Branch point ${index} must be a strict ancestor of branch point ${index + 1}.`);
    }
    try {
      await runGit(
        ["merge-base", "--is-ancestor", commits[index - 1], commits[index]],
        cwd,
        signal,
      );
    } catch (error: unknown) {
      if (exitCode(error) === 1) {
        return fail(`Branch point ${index} must be an ancestor of branch point ${index + 1}.`);
      }
      return fail(
        `Could not verify ancestry between branch points ${index} and ${index + 1}: ${commandErrorOutput(error)}`,
      );
    }
  }

  const missing: { branch: string; commit: string }[] = [];
  for (const [index, branch] of branches.entries()) {
    let exists = false;
    try {
      await runGit(["show-ref", "--verify", "--quiet", branchRef(branch)], cwd, signal);
      exists = true;
    } catch (error: unknown) {
      if (exitCode(error) !== 1) {
        return fail(`Could not inspect local branch \`${branch}\`: ${commandErrorOutput(error)}`);
      }
    }

    if (!exists) {
      missing.push({ branch, commit: commits[index] });
      continue;
    }

    const existing = await resolveCommit(
      cwd,
      branchRef(branch),
      `local branch \`${branch}\``,
      signal,
    );
    if ("error" in existing) return fail(existing.error);
    if (existing.commit !== commits[index]) {
      return fail(
        `Local branch \`${branch}\` already exists at ${existing.commit}, but branch point ${index + 1} resolves to ${commits[index]}.`,
      );
    }
  }

  for (const { branch, commit } of missing) {
    try {
      // Supplying the zero old value makes creation atomic and refuses to
      // overwrite a branch that appeared after the existence check.
      // Ref creation is a short critical section. Do not forward cancellation:
      // cleanup cannot track a ref if Git creates it while an abort hides the result.
      await runGit(["update-ref", branchRef(branch), commit, ZERO_SHA], cwd);
      created.push({ branch, commit });
    } catch (error: unknown) {
      return fail(`Could not create local branch \`${branch}\`: ${commandErrorOutput(error)}`);
    }
  }

  return {
    success: true,
    output: "",
    createdBranches: created.map(({ branch }) => branch),
    commits,
  };
}
