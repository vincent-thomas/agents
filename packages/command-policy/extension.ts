/**
 * extension.ts — builds a Pi extension that allows only configured shell
 * command invocations via the bash tool. Rules can match commands,
 * subcommands, and banned flags.
 *
 * This file is pure Pi wiring: the actual policy decision (which violation,
 * if any, and what to say about it) lives in evaluateCommand (matching.ts),
 * which has no Pi dependency and is tested directly there.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type { CommandPolicyEntry } from "./types.ts";
import { evaluateCommand } from "./matching.ts";

export interface CommandPolicyOptions {
  entries: CommandPolicyEntry[];
}

const COMMAND_POLICY_SYSTEM_PROMPT = `
Only run shell commands that are explicitly allowed by the command policy.
The policy can allow or ban commands by command, subcommand, and flag.
When a command is banned, follow the policy description for what to do instead.
Prefer Pi tools over shell commands when possible: use read for file contents,
write/edit for file changes, rg for search, and fd for file discovery.
`;

export function createCommandPolicyExtension(options: CommandPolicyOptions) {
  return function (pi: ExtensionAPI) {
    pi.on("before_agent_start", async (event) => ({
      systemPrompt: event.systemPrompt + COMMAND_POLICY_SYSTEM_PROMPT,
    }));

    pi.on("tool_call", async (event, ctx) => {
      if (!isToolCallEventType("bash", event)) return;

      const command = event.input.command ?? "";
      const violation = evaluateCommand(command, options.entries);
      if (!violation) return;

      if (ctx.hasUI) ctx.ui.notify(violation.notify, "warning");
      return { block: true, reason: violation.reason };
    });
  };
}
