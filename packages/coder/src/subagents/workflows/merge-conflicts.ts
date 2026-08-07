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

export type RebaseContinuationResult = StackRebaseContinuationResult;

export interface CreateMergeConflictsWorkflowOptions {
  assertWorkspace(cwd: string): Promise<void>;
  commandOutput?: CommandOutputFn;
  commit?: (options: RunGitCommitOptions) => Promise<{ success: boolean; output: string }>;
  continueStackRebase?: (
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<StackRebaseContinuationResult>;
  continueRebase?: (cwd: string, signal?: AbortSignal) => Promise<RebaseContinuationResult>;
  skipRebase?: (cwd: string, signal?: AbortSignal) => Promise<RebaseContinuationResult>;
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

function continuingRebasePrompt(output: string, unmergedEntries: string): string {
  return [
    "The rebase advanced to another conflicted commit.",
    "Resolve and stage every path below. The host will continue the noninteractive rebase again.",
    "",
    "git rebase --continue output:",
    output,
    "",
    "Unmerged index entries:",
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

function isEmptyRebaseReplayOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  const describesEmptyReplay =
    normalized.includes("previous cherry-pick is now empty") ||
    normalized.includes("previous commit is now empty") ||
    normalized.includes("current patch is now empty") ||
    normalized.includes("no changes -");
  return describesEmptyReplay && normalized.includes("git rebase --skip");
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
  const continueRebase =
    options.continueRebase ??
    (async (cwd: string, signal?: AbortSignal): Promise<RebaseContinuationResult> => {
      try {
        // defaultCommandOutput supplies GIT_EDITOR=true for this invocation,
        // so Git never opens an interactive editor for the rebase message.
        const output = await commandOutput("git", ["rebase", "--continue"], cwd, signal);
        return { success: true, output };
      } catch (error) {
        return { success: false, output: commandErrorOutput(error) };
      }
    });
  const skipRebase =
    options.skipRebase ??
    (async (cwd: string, signal?: AbortSignal): Promise<RebaseContinuationResult> => {
      try {
        const output = await commandOutput("git", ["rebase", "--skip"], cwd, signal);
        return { success: true, output };
      } catch (error) {
        return { success: false, output: commandErrorOutput(error) };
      }
    });

  return async ({ cwd, prompt: initialPrompt, signal, subagent, onProgress }) => {
    let prompt = initialPrompt;
    let stackOriginalBranch: string | undefined;

    while (true) {
      await subagent.session.prompt(prompt);

      const unmergedEntries = await commandOutput("git", ["ls-files", "-u"], cwd, signal);
      if (unmergedEntries.trim() !== "") {
        onProgress("Conflicts remain; resuming the conflict resolver…");
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
          onProgress("Continuing the in-progress rebase…");
          const continuation = await continueRebase(cwd, signal);
          const pendingUnmergedEntries = await commandOutput(
            "git",
            ["ls-files", "-u"],
            cwd,
            signal,
          );
          if (pendingUnmergedEntries.trim() !== "") {
            onProgress("The rebase reached another conflict; resuming the resolver…");
            prompt = continuingRebasePrompt(continuation.output, pendingUnmergedEntries);
            continue;
          }
          let finalContinuation = continuation;
          if (!continuation.success) {
            if (isEmptyRebaseReplayOutput(continuation.output)) {
              onProgress("The resolved commit is empty; skipping it noninteractively…");
              finalContinuation = await skipRebase(cwd, signal);
              const pendingAfterSkip = await commandOutput("git", ["ls-files", "-u"], cwd, signal);
              if (pendingAfterSkip.trim() !== "") {
                onProgress("The rebase reached another conflict; resuming the resolver…");
                prompt = continuingRebasePrompt(
                  `${continuation.output}\n\ngit rebase --skip output:\n${finalContinuation.output}`,
                  pendingAfterSkip,
                );
                continue;
              }
            } else {
              throw new Error(
                `git rebase --continue failed without producing conflicts:\n${continuation.output}`,
              );
            }
          }
          if (!finalContinuation.success) {
            throw new Error(
              `git rebase --skip failed without producing conflicts:\n${finalContinuation.output}`,
            );
          }
          if ((await detectGitOperation(cwd, commandOutput, signal, pathExists)) !== "none") {
            throw new Error("git rebase --continue returned before the rebase finished");
          }

          await options.assertWorkspace(cwd);
          const report = subagent.session.getLastAssistantText()?.trim();
          return [
            report,
            finalContinuation.output || "Rebase conflicts resolved and rebase completed.",
          ]
            .filter((text): text is string => Boolean(text))
            .join("\n\n");
        }
        stackOriginalBranch ??= await readStackRebaseOriginalBranch(cwd, signal);

        onProgress("Continuing the cascading GitHub stack rebase…");
        const continuation = await continueStackRebase(cwd, signal);
        const pendingUnmergedEntries = await commandOutput("git", ["ls-files", "-u"], cwd, signal);
        if (pendingUnmergedEntries.trim() !== "") {
          onProgress("The stack rebase reached another conflict; resuming the resolver…");
          prompt = continuingStackRebasePrompt(continuation.output, pendingUnmergedEntries);
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

        const restoration = await restoreBranch(cwd, stackOriginalBranch, signal);
        if (!restoration.success) {
          throw new Error(
            `GitHub stack rebase completed, but the owned branch ${stackOriginalBranch} could not be restored:\n${restoration.output}`,
          );
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
