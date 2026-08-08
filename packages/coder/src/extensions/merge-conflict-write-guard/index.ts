import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { detectGitOperation, gitPathExists, type GitOperation } from "../../git-operation.ts";

export function mergeConflictWriteBlockReason(
  operation: GitOperation,
  stackRebase = false,
): string {
  switch (operation) {
    case "merge":
      return 'Unresolved merge conflicts are present. Call agent with actor: "merge_conflicts" before calling write.';
    case "rebase":
      return stackRebase
        ? 'A GitHub stack rebase conflict is in progress. Call agent with actor: "merge_conflicts" before calling write.'
        : 'An ordinary rebase conflict is in progress. Call agent with actor: "merge_conflicts" before calling write.';
    case "cherry-pick":
      return "A cherry-pick conflict is in progress; resolve it outside this merge-only workflow before calling write.";
    case "revert":
      return "A revert conflict is in progress; resolve it outside this merge-only workflow before calling write.";
    case "none":
      return "The index contains unmerged entries without a recognized Git operation; resolve them before calling write.";
  }
}

export function mergeConflictWriteGuardExtension(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // Keep exact edits available to the conflict resolver; only prevent a
    // whole-file write from accidentally discarding either side.
    if (!isToolCallEventType("write", event)) return;

    const result = await pi.exec("git", ["ls-files", "-u"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 5_000,
    });
    if (result.code !== 0 || result.stdout.trim() === "") return;

    const operation = await detectGitOperation(
      ctx.cwd,
      async (command, args, cwd, signal) => {
        const operationResult = await pi.exec(command, args, {
          cwd,
          signal,
          timeout: 5_000,
        });
        if (operationResult.code !== 0) throw new Error(operationResult.stderr);
        return operationResult.stdout;
      },
      ctx.signal,
    );
    const stackRebase =
      operation === "rebase" &&
      (await gitPathExists(
        "gh-stack-rebase-state",
        ctx.cwd,
        async (command, args, cwd, signal) => {
          const stateResult = await pi.exec(command, args, {
            cwd,
            signal,
            timeout: 5_000,
          });
          if (stateResult.code !== 0) throw new Error(stateResult.stderr);
          return stateResult.stdout;
        },
        ctx.signal,
      ));
    const blockReason = mergeConflictWriteBlockReason(operation, stackRebase);
    if (ctx.hasUI) ctx.ui.notify(blockReason, "warning");
    return { block: true, reason: blockReason };
  });
}
