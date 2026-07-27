import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const BLOCK_REASON =
  "Unresolved Git conflicts are present. Use the merge_conflicts sub-agent to resolve them before calling write.";

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

    if (ctx.hasUI) ctx.ui.notify(BLOCK_REASON, "warning");
    return { block: true, reason: BLOCK_REASON };
  });
}
