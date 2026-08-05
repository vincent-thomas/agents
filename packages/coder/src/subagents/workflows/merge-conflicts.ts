import { existsSync } from "node:fs";
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
  return [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join("\n");
}

export function createMergeConflictsWorkflow(
  options: CreateMergeConflictsWorkflowOptions,
): SubagentWorkflowFn {
  const commandOutput = options.commandOutput ?? defaultCommandOutput;
  const commit = options.commit ?? runGitCommit;
  const pathExists = options.pathExists ?? existsSync;
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

        onProgress("Continuing the cascading GitHub stack rebase…");
        const continuation = await continueStackRebase(cwd, signal);
        const nextUnmergedEntries = await commandOutput("git", ["ls-files", "-u"], cwd, signal);
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
        if ((await detectGitOperation(cwd, commandOutput, signal, pathExists)) !== "none") {
          throw new Error("gh stack rebase --continue returned before the stack rebase finished");
        }

        await options.assertWorkspace(cwd);
        const report = subagent.session.getLastAssistantText()?.trim();
        return [report, continuation.output || "GitHub stack rebase completed."]
          .filter((text): text is string => Boolean(text))
          .join("\n\n");
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
