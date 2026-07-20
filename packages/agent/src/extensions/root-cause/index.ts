import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  fetchFailureLogs,
  isFailure,
  pollChecks,
} from "@vt-agent/git_push/logic.ts";
import { buildRootCausePrompt } from "./logic.ts";

export function rootCauseExtension(pi: ExtensionAPI) {
  pi.registerCommand("rootcause", {
    description: "Find the root cause of CI failures for the current commit",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const updateStatus = (message?: string) => {
        if (ctx.hasUI) ctx.ui.setStatus("rootcause", message);
      };

      try {
        const result = await pollChecks(ctx.cwd, undefined, updateStatus);
        const failures = result.checks.filter((check) => isFailure(check.bucket));

        if (failures.length === 0) {
          const message =
            result.checks.length === 0
              ? `No CI checks were found for ${result.mode}.`
              : result.timedOut
                ? `CI is still running for ${result.mode}; no failed checks are available to diagnose.`
                : `All CI checks passed for ${result.mode}.`;
          ctx.ui.notify(message, result.timedOut ? "warning" : "info");
          return;
        }

        updateStatus(`Fetching logs for ${failures.length} failed check(s)…`);
        const failureLogs = await fetchFailureLogs(failures, ctx.cwd);
        pi.sendUserMessage(buildRootCausePrompt(result.mode, result.checks, failureLogs, args));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not inspect CI: ${message}`, "error");
      } finally {
        updateStatus();
      }
    },
  });
}

export default rootCauseExtension;
