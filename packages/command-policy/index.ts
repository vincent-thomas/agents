/**
 * @vt-pi/command-policy — a Pi extension factory that allows only configured
 * shell command invocations via the bash tool.
 *
 * This is the package's only public entry point (see package.json's
 * "exports"). It exposes the extension factory, policy types, and the pure
 * evaluator hosts use to regression-test concrete policies:
 *
 *   import createCommandPolicyExtension, { CommandPolicyStatus } from "@vt-pi/command-policy";
 *   export default createCommandPolicyExtension({ entries: [...] });
 *
 * The rest of the matching engine (matchesEntry, findBannedFlag, …) and
 * command-utils.ts remain private implementation details.
 */

export { createCommandPolicyExtension, type CommandPolicyOptions } from "./extension.ts";
export { evaluateCommand } from "./matching.ts";
export { CommandPolicyStatus, type CommandPolicyEntry, type CommandUse } from "./types.ts";
