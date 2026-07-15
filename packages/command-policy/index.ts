/**
 * @vt-pi/command-policy — a Pi extension factory that allows only configured
 * shell command invocations via the bash tool.
 *
 * This is the package's only public entry point (see package.json's
 * "exports"), and createCommandPolicyExtension plus the types needed to
 * build a CommandPolicyEntry[] for it are its only exports:
 *
 *   import createCommandPolicyExtension, { CommandPolicyStatus } from "@vt-pi/command-policy";
 *   export default createCommandPolicyExtension({ entries: [...] });
 *
 * The matching engine (matchesEntry, findBannedFlag, …) and command-utils.ts
 * are private implementation, used only internally by
 * createCommandPolicyExtension — not exported, not meant to be depended on
 * directly.
 */

export { createCommandPolicyExtension, type CommandPolicyOptions } from "./extension.ts";
export { CommandPolicyStatus, type CommandPolicyEntry, type CommandUse } from "./types.ts";
