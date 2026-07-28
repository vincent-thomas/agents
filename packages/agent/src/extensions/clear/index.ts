import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { unlink } from "node:fs/promises";

export function innerClearSession(options: {
  deleteSessionFn: (sessionFile: string) => Promise<void>;
}) {
  return async function clearSession(ctx: ExtensionCommandContext) {
    await ctx.waitForIdle();
    const previousSessionFile = ctx.sessionManager.getSessionFile();

    await ctx.newSession({
      withSession: async (ctx) => {
        if (!previousSessionFile) return;

        try {
          await options.deleteSessionFn(previousSessionFile);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not delete previous session: ${message}`, "error");
        }
      },
    });
  };
}

export function clearSessionExtension(pi: ExtensionAPI) {
  const clearSession = innerClearSession({ deleteSessionFn: unlink });

  pi.registerCommand("clear", {
    description: "Start a new session and delete the current one",
    handler: async (_args, ctx) => clearSession(ctx),
  });
}

export default clearSessionExtension;
