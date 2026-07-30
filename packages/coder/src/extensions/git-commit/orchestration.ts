import { execAsync, extractErrorOutput } from "./exec-async.ts";
import { currentBranch, hasUpstream } from "./git-utils.ts";
import { branchExistsOnRemote, gitCommit, isDefaultBranch } from "./logic.ts";
import { formatSuccessfulPreChecks, runGitPreChecks, runPreChecks } from "./precheck.ts";

export interface RunGitCommitOptions {
  cwd: string;
  message?: string;
  addAll: boolean;
  signal?: AbortSignal;
  assertWorkspace(cwd: string): Promise<void>;
  onProgress?(text: string): void;
}

export interface RunGitCommitResult {
  success: boolean;
  output: string;
}

/** Runs the policy and validation shared by the git_commit tool and code-owned workflows. */
export async function runGitCommit(options: RunGitCommitOptions): Promise<RunGitCommitResult> {
  const { cwd, signal } = options;
  await options.assertWorkspace(cwd);

  const branch = await currentBranch(cwd, signal);
  if (branch && (await isDefaultBranch(cwd, branch, signal))) {
    return {
      success: false,
      output:
        `Cannot commit on "${branch}". ` +
        "Create a feature branch first with `git checkout -b <branch-name>`, then commit there.",
    };
  }

  if (branch && (await hasUpstream(cwd, signal))) {
    if (!(await branchExistsOnRemote(cwd, branch, signal))) {
      return {
        success: false,
        output:
          `Branch "${branch}" has an upstream configured but does not exist on remote. ` +
          "This may indicate a deleted remote branch. Push it with `push_and_check_ci` or " +
          `\`git push -u origin ${branch}\`.`,
      };
    }
  }

  const completedSteps: string[] = [];
  options.onProgress?.("Running pre-commit checks…");
  const preCheck = await runPreChecks(cwd, signal, (step) => {
    const icon = step.passed ? "✅" : "❌";
    const time = step.elapsed ? ` (${step.elapsed}s)` : "";
    completedSteps.push(`${icon} ${step.command}${time}`);
    options.onProgress?.(completedSteps.join("\n"));
  });

  if (!preCheck.passed) {
    const failedStep = preCheck.steps.find((step) => !step.passed)!;
    const passedSteps = preCheck.steps
      .filter((step) => step.passed)
      .map((step) => `✅ ${step.command}`)
      .join("\n");
    return {
      success: false,
      output:
        "Pre-commit check failed. Fix the errors before committing.\n\n" +
        (passedSteps ? `${passedSteps}\n` : "") +
        `❌ \`${failedStep.command}\`:\n\`\`\`\n${failedStep.output}\n\`\`\``,
    };
  }

  if (options.addAll) {
    completedSteps.push("📦 Staging all changes…");
    options.onProgress?.(completedSteps.join("\n"));
    try {
      await execAsync("git add -A", { cwd, timeout: 15_000, signal });
    } catch (error: unknown) {
      return {
        success: false,
        output: `Staging failed:\n\`\`\`\n${extractErrorOutput(error)}\n\`\`\``,
      };
    }
  }

  const gitPreCheck = await runGitPreChecks(cwd, signal, (step) => {
    const icon = step.passed ? "✅" : "❌";
    const time = step.elapsed ? ` (${step.elapsed}s)` : "";
    completedSteps.push(`${icon} ${step.command}${time}`);
    options.onProgress?.(completedSteps.join("\n"));
  });

  if (!gitPreCheck.passed) {
    const failedStep = gitPreCheck.steps.find((step) => !step.passed)!;
    const passedSteps = gitPreCheck.steps
      .filter((step) => step.passed)
      .map((step) => `✅ ${step.command}`)
      .join("\n");
    return {
      success: false,
      output:
        "Pre-commit check failed. Fix the errors before committing.\n\n" +
        (passedSteps ? `${passedSteps}\n` : "") +
        `❌ \`${failedStep.command}\`:\n\`\`\`\n${failedStep.output}\n\`\`\``,
    };
  }

  completedSteps.push("Committing…");
  options.onProgress?.(completedSteps.join("\n"));
  const result = await gitCommit(cwd, options.message, signal);
  if (!result.success) {
    return {
      success: false,
      output: `Commit failed:\n\`\`\`\n${result.output}\n\`\`\``,
    };
  }
  return {
    success: true,
    output: [result.output, formatSuccessfulPreChecks(preCheck)].filter(Boolean).join("\n\n"),
  };
}
