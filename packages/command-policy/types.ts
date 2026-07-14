export const CommandPolicyStatus = {
	Allowed: "allowed",
	Banned: "banned",
} as const;

export type CommandPolicyStatus = (typeof CommandPolicyStatus)[keyof typeof CommandPolicyStatus];

export interface CommandUse {
	name: string;
	segment: string;
	args: string[];
	/**
	 * True when the underlying invocation could not be cleanly resolved
	 * because its command name or a flag was pointlessly quoted (e.g.
	 * `"git"`, `"-rf"`) — see this package's command-utils.ts OBFUSCATED sentinel.
	 * `name`/`args` are placeholders in this case; callers must deny the
	 * command outright rather than match it against policy entries.
	 */
	obfuscated?: boolean;
}

type CommandPolicyEntryBase = {
	/** Display name for the entry, e.g. "git status" or "rg" */
	name: string;
	/**
	 * Executable basename to match (e.g. "git", "rg"), or a predicate over the
	 * full resolved use — command name plus args — so a predicate can match on
	 * more than just the executable name, e.g. "is this invocation targeting a
	 * path inside a protected folder?"
	 */
	command: string | ((use: CommandUse) => boolean);
	/**
	 * Optional required leading args/subcommand, e.g. [["status"]] for `git status`.
	 * Each sub-array is checked independently; if ANY matches, the entry matches.
	 * So [["status"], ["diff"]] matches both `git status` and `git diff`.
	 */
	subcommand?: (string[])[];
	/** Guidance included when this entry blocks a command */
	description?: string;
};

type BannedCommandPolicyEntry = CommandPolicyEntryBase & {
	status: typeof CommandPolicyStatus.Banned;
	bannedFlags?: never;
	allowedFlags?: never;
	validate?: never;
};

type AllowedCommandPolicyEntry = CommandPolicyEntryBase & {
	status: typeof CommandPolicyStatus.Allowed;
	/** Flags that are forbidden when this entry matches. Mutually exclusive with allowedFlags. */
	bannedFlags?: string[];
	allowedFlags?: never;
	/** Optional extra validation for argument-sensitive allowed entries */
	validate?: (use: CommandUse) => string | null;
};

type AllowedCommandPolicyEntryWithAllowedFlags = CommandPolicyEntryBase & {
	status: typeof CommandPolicyStatus.Allowed;
	bannedFlags?: never;
	/** The only flags allowed when this entry matches. Mutually exclusive with bannedFlags. */
	allowedFlags: string[];
	/** Optional extra validation for argument-sensitive allowed entries */
	validate?: (use: CommandUse) => string | null;
};

export type CommandPolicyEntry =
	| BannedCommandPolicyEntry
	| AllowedCommandPolicyEntry
	| AllowedCommandPolicyEntryWithAllowedFlags;
