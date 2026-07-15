/**
 * Write Guard Extension
 *
 * Blocks the `write` tool from overwriting existing files that are above a
 * line threshold. Forces the agent to use `edit` instead, which is safer
 * because it requires matching exact text and can't silently drop content.
 *
 * New files (that don't exist yet) are always allowed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkFileTooLarge } from "./logic.ts";

export interface WriteGuardExtensionOptions {
  overwriteFileThreshold: number;
}

export function createwriteGuardExtension({ overwriteFileThreshold }: WriteGuardExtensionOptions) {
  return function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
      // Only the write tool overwrites an existing file wholesale; edit is
      // already safe (it must match exact text), so we only guard write.
      if (!isToolCallEventType("write", event)) return;

      const filePath = event.input.path;
      if (!filePath) return;

      const absolute = resolve(ctx.cwd, filePath);
      if (!existsSync(absolute)) return; // new file — allow

      let content: string;
      try {
        content = readFileSync(absolute, "utf-8");
      } catch {
        return; // can't read — let write proceed
      }

      const blockReason = checkFileTooLarge(filePath, content, overwriteFileThreshold);
      if (!blockReason) return; // small enough — allow

      if (ctx.hasUI) {
        ctx.ui.notify(
          `✋ Blocked overwrite of ${filePath} (too large). Use edit instead.`,
          "warning",
        );
      }

      return { block: true, reason: blockReason };
    });
  };
}
