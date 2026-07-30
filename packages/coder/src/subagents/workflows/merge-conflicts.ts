import {
  runGitCommit,
  type RunGitCommitOptions,
} from "../../extensions/git-commit/orchestration.ts";
import { refExists } from "../../git-operation.ts";
import type { SubagentWorkflowFn } from "../catalog.ts";
import { defaultCommandOutput, type CommandOutputFn } from "../prompts/merge-conflicts.ts";

export interface CreateMergeConflictsWorkflowOptions {
  assertWorkspace(cwd: string): Promise<void>;
  commandOutput?: CommandOutputFn;
  commit?: (options: RunGitCommitOptions) => Promise<{ success: boolean; output: string }>;
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

function failedCommitPrompt(output: string): string {
  return [
    "The host could not complete the required commit workflow.",
    "Fix the reported validation or commit problem, stage every resulting fix, and respond only when the repository is ready for the host to retry.",
    "Do not commit the changes yourself.",
    "",
    output,
  ].join("\n");
}

export function createMergeConflictsWorkflow(
  options: CreateMergeConflictsWorkflowOptions,
): SubagentWorkflowFn {
  const commandOutput = options.commandOutput ?? defaultCommandOutput;
  const commit = options.commit ?? runGitCommit;

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

      if (!(await refExists("MERGE_HEAD", cwd, commandOutput, signal))) {
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

      if (await refExists("MERGE_HEAD", cwd, commandOutput, signal)) {
        throw new Error("The commit completed without finishing the in-progress merge");
      }

      const report = subagent.session.getLastAssistantText()?.trim();
      return [report, result.output || "Merge conflicts resolved, validated, and committed."]
        .filter((text): text is string => Boolean(text))
        .join("\n\n");
    }
  };
}
