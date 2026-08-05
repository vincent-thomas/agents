import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runGitCommit,
  type RunGitCommitOptions,
} from "../../extensions/git-commit/orchestration.ts";
import { detectGitOperation, gitPathExists } from "../../git-operation.ts";
import type { SubagentWorkflowFn } from "../catalog.ts";
import { defaultCommandOutput, type CommandOutputFn } from "../prompts/merge-conflicts.ts";

export interface StackRebaseContinuationResult {
  success: boolean;
  output: string;
}

export interface CreateMergeConflictsWorkflowOptions {
  assertWorkspace(cwd: string): Promise<void>;
  commandOutput?: CommandOutputFn;
  commit?: (options: RunGitCommitOptions) => Promise<{ success: boolean; output: string }>;
  continueStackRebase?: (
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<StackRebaseContinuationResult>;
  readStackRebaseOriginalBranch?: (cwd: string, signal?: AbortSignal) => Promise<string>;
  restoreBranch?: (
    cwd: string,
    branch: string,
    signal?: AbortSignal,
  ) => Promise<StackRebaseContinuationResult>;
  pathExists?: (path: string) => boolean;
}

function remainingConflictsPrompt(unmergedEntries: string): string {
  return [
    "You stopped before resolving every conflict. Continue working; do not merely report the remaining work.",
    "Resolve and stage every path below, then verify that git ls-files -u is empty before responding again.",
    "",
    "Remaining unmerged index entries:",
    unmergedEntries,
  ].join("\n");
}

function continuingStackRebasePrompt(output: string, unmergedEntries: string): string {
  return [
    "The GitHub stack rebase advanced to another conflicted branch.",
    "Resolve and stage every path below. The host will then continue the cascading stack rebase again.",
    "",
    "gh stack rebase --continue output:",
    output,
    "",
    "Unmerged index entries:",
    unmergedEntries,
  ].join("\n");
}

function failedCommitPrompt(output: string): string {
  return [
    "The host could not complete the required commit workflow.",
    "Fix the reported validation or commit problem, stage every resulting fix, and respond only when the repository is ready for the host to retry.",
    "Do not commit the changes yourself.",
    "",
    output,
  ].join("\n");
}

function commandErrorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const result = error as { stdout?: unknown; stderr?: unknown };
  const output = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join("\n");
  return output || (error instanceof Error ? error.message : String(error));
}

export function parseStackRebaseOriginalBranch(contents: string): string | null {
  try {
    const state = JSON.parse(contents) as Record<string, unknown>;
    const branch = state.originalBranch ?? state.original_branch;
    return typeof branch === "string" && branch.trim() !== "" ? branch : null;
  } catch {
    return null;
  }
}

export function createMergeConflictsWorkflow(
  options: CreateMergeConflictsWorkflowOptions,
): SubagentWorkflowFn {
  const commandOutput = options.commandOutput ?? defaultCommandOutput;
  const commit = options.commit ?? runGitCommit;
  const pathExists = options.pathExists ?? existsSync;
  const readStackRebaseOriginalBranch =
    options.readStackRebaseOriginalBranch ??
    (async (cwd: string, signal?: AbortSignal): Promise<string> => {
      const statePath = (
        await commandOutput(
          "git",
          ["rev-parse", "--git-path", "gh-stack-rebase-state"],
          cwd,
          signal,
        )
      ).trim();
      const branch = parseStackRebaseOriginalBranch(readFileSync(resolve(cwd, statePath), "utf8"));
      if (!branch) throw new Error("gh-stack-rebase-state does not record the original branch");
      return branch;
    });
  const restoreBranch =
    options.restoreBranch ??
    (async (
      cwd: string,
      branch: string,
      signal?: AbortSignal,
    ): Promise<StackRebaseContinuationResult> => {
      try {
        const output = await commandOutput("git", ["switch", "--", branch], cwd, signal);
        return { success: true, output };
      } catch (error) {
        return { success: false, output: commandErrorOutput(error) };
      }
    });
  const continueStackRebase =
    options.continueStackRebase ??
    (async (cwd: string, signal?: AbortSignal): Promise<StackRebaseContinuationResult> => {
      try {
        const output = await commandOutput("gh", ["stack", "rebase", "--continue"], cwd, signal);
        return { success: true, output };
      } catch (error) {
        return { success: false, output: commandErrorOutput(error) };
      }
    });

  return async ({ cwd, prompt: initialPrompt, signal, subagent, onProgress }) => {
    let prompt = initialPrompt;
    let stackOriginalBranch: string | undefined;
    const stackResolutionReports: string[] = [];

    while (true) {
      await subagent.session.prompt(prompt);

      const unmergedEntries = await commandOutput("git", ["ls-files", "-u"], cwd, signal);
      if (unmergedEntries.trim() !== "") {
        onProgress("Conflicts remain; resuming the merge resolver…");
        prompt = remainingConflictsPrompt(unmergedEntries);
        continue;
      }

      const operation = await detectGitOperation(cwd, commandOutput, signal, pathExists);
      if (operation === "rebase") {
        const stackRebase = await gitPathExists(
          "gh-stack-rebase-state",
          cwd,
          commandOutput,
          signal,
          pathExists,
        );
        if (!stackRebase) {
          throw new Error("merge_conflicts cannot continue an in-progress non-stack rebase");
        }
        stackOriginalBranch ??= await readStackRebaseOriginalBranch(cwd, signal);
        const report = subagent.session.getLastAssistantText()?.trim();
        const resolutionNumber = stackResolutionReports.length + 1;
        stackResolutionReports.push(
          report
            ? `Stack conflict ${resolutionNumber}:\n${report}`
            : `Stack conflict ${resolutionNumber}: resolved and staged.`,
        );

        onProgress("Continuing the cascading GitHub stack rebase…");
        const continuation = await continueStackRebase(cwd, signal);
        // The stack command may complete just as cancellation arrives. Verify
        // and restore its resulting checkout without reusing an aborted signal.
        const nextUnmergedEntries = await commandOutput("git", ["ls-files", "-u"], cwd);
        if (nextUnmergedEntries.trim() !== "") {
          onProgress("The stack rebase reached another conflict; resuming the resolver…");
          prompt = continuingStackRebasePrompt(continuation.output, nextUnmergedEntries);
          continue;
        }
        if (!continuation.success) {
          throw new Error(
            `gh stack rebase --continue failed without producing conflicts:\n${continuation.output}`,
          );
        }
        if ((await detectGitOperation(cwd, commandOutput, undefined, pathExists)) !== "none") {
          throw new Error("gh stack rebase --continue returned before the stack rebase finished");
        }

        const restoration = await restoreBranch(cwd, stackOriginalBranch);
        if (!restoration.success) {
          throw new Error(
            `GitHub stack rebase completed, but the owned branch ${stackOriginalBranch} could not be restored:\n${restoration.output}`,
          );
        }
        await options.assertWorkspace(cwd);
        return [
          ...stackResolutionReports,
          continuation.output || "GitHub stack rebase completed.",
        ].join("\n\n");
      }

      if (operation !== "merge") {
        throw new Error("The merge ended before merge_conflicts could create the merge commit");
      }

      const result = await commit({
        cwd,
        addAll: false,
        signal,
        assertWorkspace: options.assertWorkspace,
        onProgress,
      });
      if (!result.success) {
        onProgress("Required checks or commit failed; resuming the merge resolver…");
        prompt = failedCommitPrompt(result.output);
        continue;
      }

      if ((await detectGitOperation(cwd, commandOutput, signal, pathExists)) === "merge") {
        throw new Error("The commit completed without finishing the in-progress merge");
      }

      const report = subagent.session.getLastAssistantText()?.trim();
      return [report, result.output || "Merge conflicts resolved, validated, and committed."]
        .filter((text): text is string => Boolean(text))
        .join("\n\n");
    }
  };
}
