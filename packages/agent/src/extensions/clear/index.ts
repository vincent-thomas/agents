import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unlink } from "node:fs/promises";

export function createClearExtension(
  options: {
    deleteSession?: (sessionFile: string) => Promise<void>;
  } = {},
) {
  const deleteSession = options.deleteSession ?? unlink;

  return function clearExtension(pi: ExtensionAPI) {
    pi.registerCommand("clear", {
      description: "Start a new session and delete the current one",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        const previousSessionFile = ctx.sessionManager.getSessionFile();

        await ctx.newSession({
          withSession: async (ctx) => {
            if (!previousSessionFile) return;

            try {
              await deleteSession(previousSessionFile);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`Could not delete previous session: ${message}`, "error");
            }
          },
        });
      },
    });
  };
}

export const clearExtension = createClearExtension();
export default clearExtension;
