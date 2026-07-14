/**
 * matching.ts — pure matching logic for command policy enforcement.
 *
 * No dependency on anything else in the vt-pi workspace — importable from
 * any test or logic module on its own.
 */
import { splitCommandSegments, commandInvocation, OBFUSCATED } from "./command-utils.ts";
import { CommandPolicyStatus, type CommandPolicyEntry, type CommandUse } from "./types.ts";

export { CommandPolicyStatus, type CommandPolicyEntry, type CommandUse };

/** True for short-flag syntax: a single leading dash followed by non-dash characters (e.g. `-r`, `-rf`, but not `--force`). */
function isShortFlag(s: string): boolean {
	return s.length >= 2 && s[0] === "-" && s[1] !== "-";
}

/** True for a single-character short flag, e.g. `-r` (not the bundled `-rf`). */
function isSingleShortFlag(s: string): boolean {
	return s.length === 2 && isShortFlag(s);
}

/** True for a bundled/combined short flag, e.g. `-rfv` — multiple chars, no `=value`. */
function isCombinedShortFlag(s: string): boolean {
	return s.length > 2 && isShortFlag(s) && !s.includes("=");
}

/** The characters after the leading dash of a short flag, e.g. `-rfv` -> `["r", "f", "v"]`. */
function shortFlagChars(s: string): string[] {
	return [...s.slice(1)];
}

/**
 * Check whether a command use matches a policy entry.
 */
export function matchesEntry(use: CommandUse, entry: CommandPolicyEntry): boolean {
	const commandMatches =
		typeof entry.command === "string" ? use.name === entry.command.toLowerCase() : entry.command(use);
	if (!commandMatches) return false;
	if (!entry.subcommand) return true;
	// subcommand is a list of arrays — ANY matching sub-array is sufficient (OR semantics).
	return entry.subcommand.some((sub) =>
		sub.every((part, index) => use.args[index]?.toLowerCase() === part.toLowerCase()),
	);
}

/**
 * Check whether an arg matches a flag.
 *
 * Handles exact match, `flag=value` form, and combined short flags
 * (e.g. `-rfv` matches banned flag `-r` or `-rf`).
 */
export function flagMatches(arg: string, flag: string): boolean {
	if (arg === flag || arg.startsWith(`${flag}=`)) return true;

	// Handle combined short flags: `-rfv` should match banned `-r` or `-rf`.
	if (isShortFlag(arg) && isShortFlag(flag)) {
		const argChars = new Set(shortFlagChars(arg));
		return shortFlagChars(flag).every((ch) => argChars.has(ch));
	}

	return false;
}

/**
 * Extract flag arguments from a command use, excluding `--`.
 */
export function commandFlags(use: CommandUse): string[] {
	return use.args.filter((arg) => arg.startsWith("-") && arg !== "--");
}

/**
 * Find the first banned flag present in a command use.
 */
export function findBannedFlag(use: CommandUse, entry: CommandPolicyEntry): string | null {
	for (const flag of entry.bannedFlags ?? []) {
		if (use.args.some((arg) => flagMatches(arg, flag))) return flag;
	}
	return null;
}

/**
 * Find the first flag in a command use that is not in the entry's allowed set.
 * Returns null when there is no allowedFlags restriction, or when all flags
 * are allowed.
 *
 * Combined short flags (e.g. `-sv`) are checked character-by-character: every
 * character must be covered by an allowed single-char flag (e.g. `-s`), so an
 * arbitrary flag can't be smuggled in by bundling it with an allowed one.
 */
export function findDisallowedFlag(use: CommandUse, entry: CommandPolicyEntry): string | null {
	if (!entry.allowedFlags) return null;

	const allowedChars = new Set<string>();
	for (const allowed of entry.allowedFlags) {
		if (isSingleShortFlag(allowed)) allowedChars.add(allowed[1]);
	}

	for (const flag of commandFlags(use)) {
		// Strip a trailing `=value` before checking for a combined short flag, so a
		// disallowed char can't be smuggled in behind `=` (e.g. `-sv=val` bundling
		// disallowed `-v` with allowed `-s`) — isCombinedShortFlag alone rejects
		// anything containing `=`, which would otherwise skip the char-by-char check.
		const body = flag.includes("=") ? flag.slice(0, flag.indexOf("=")) : flag;
		if (isCombinedShortFlag(body)) {
			if (shortFlagChars(body).some((ch) => !allowedChars.has(ch))) return flag;
			continue;
		}
		if (!entry.allowedFlags.some((allowed) => flagMatches(flag, allowed))) return flag;
	}
	return null;
}

/**
 * Extract all command uses from shell text.
 */
export function getCommandUses(text: string): CommandUse[] {
	const uses: CommandUse[] = [];
	for (const segment of splitCommandSegments(text)) {
		const invocation = commandInvocation(segment);
		if (invocation === null) continue;
		if (invocation === OBFUSCATED) {
			uses.push({ name: OBFUSCATED, args: [], segment: segment.trim(), obfuscated: true });
			continue;
		}
		uses.push({ ...invocation, segment: segment.trim() });
	}
	return uses;
}

/** True if raw shell text contains `<<` (a here-doc) outside of quotes. */
function hasHereDoc(text: string): boolean {
	let quote: "'" | '"' | null = null;
	let escape = false;
	for (let i = 0; i < text.length - 1; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "<" && next === "<") return true;
	}
	return false;
}

interface CommandPolicyViolation {
	/** Short message suitable for a UI toast/notification. */
	notify: string;
	/** Full explanation returned to the agent as the blocked tool call's reason. */
	reason: string;
}

/**
 * Evaluate raw shell text against policy entries and return the first
 * violation found — here-doc, obfuscation, no matching entry, banned status,
 * a banned/disallowed flag, or entry-specific validation — or null if every
 * command use in the text is allowed.
 *
 * Pure — no Pi dependency — so the whole decision (which violation, and what
 * to say about it) is testable on its own, independent of how a caller
 * reports it (see extension.ts, which just calls this and relays the result
 * to ctx.ui.notify / the blocked tool-call reason).
 */
export function evaluateCommand(command: string, entries: CommandPolicyEntry[]): CommandPolicyViolation | null {
	if (hasHereDoc(command)) {
		return {
			notify: "🚫 Blocked here-doc (<<).",
			reason:
				`Here-docs (<<) are not allowed. ` +
				`Use inline input or other methods instead. ` +
				`Blocked: \`${command.trim()}\``,
		};
	}

	for (const use of getCommandUses(command)) {
		if (use.obfuscated) {
			return {
				notify: `🚫 Blocked disguised command.`,
				reason:
					`Command name or flag is pointlessly quoted or backslash-escaped ` +
					`(blocked: \`${use.segment}\`) — e.g. \`"git"\`, \`\\-rf\`, or \`g""it\` run identically ` +
					`to \`git\` or \`-rf\` but hide from the command policy. Rewrite the command with the ` +
					`command name and flags written plainly, with no quotes or backslashes.`,
			};
		}

		const entry = entries.find((candidate) => matchesEntry(use, candidate));
		if (!entry) {
			return {
				notify: `🚫 Blocked ${use.name}.`,
				reason: `Command is not on the allow list (blocked: \`${use.segment}\`).`,
			};
		}

		if (entry.status === CommandPolicyStatus.Banned) {
			return {
				notify: `🚫 Blocked ${entry.name}.`,
				reason: `${entry.name} is banned (blocked: \`${use.segment}\`). ${entry.description ?? ""}`,
			};
		}

		const bannedFlag = findBannedFlag(use, entry);
		if (bannedFlag) {
			return {
				notify: `🚫 Blocked ${entry.name} flag ${bannedFlag}.`,
				reason: `Flag \`${bannedFlag}\` is not allowed for ${entry.name} (blocked: \`${use.segment}\`). ${entry.description ?? ""}`,
			};
		}

		const disallowedFlag = findDisallowedFlag(use, entry);
		if (disallowedFlag) {
			return {
				notify: `🚫 Blocked ${entry.name} flag ${disallowedFlag}.`,
				reason:
					`Flag \`${disallowedFlag}\` is not in the allowed flags for ${entry.name} ` +
					`(blocked: \`${use.segment}\`). Allowed flags: ${entry.allowedFlags?.join(", ")}. ` +
					`${entry.description ?? ""}`,
			};
		}

		const validationError = entry.validate?.(use);
		if (validationError) {
			return {
				notify: `🚫 Blocked ${entry.name}.`,
				reason: `${entry.name} is not allowed here (blocked: \`${use.segment}\`). ${validationError}`,
			};
		}
	}

	return null;
}
