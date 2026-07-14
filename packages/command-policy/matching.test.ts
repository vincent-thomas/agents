/**
 * matching.test.ts — tests for command policy matching helpers.
 *
 * Run with:   node --test matching.test.ts
 */
import assert from "node:assert/strict";
import { test, suite } from "node:test";
import { CommandPolicyStatus, type CommandUse } from "./types.ts";
import {
	matchesEntry,
	flagMatches,
	commandFlags,
	findBannedFlag,
	findDisallowedFlag,
	getCommandUses,
	evaluateCommand,
} from "./matching.ts";
import type { CommandPolicyEntry } from "./types.ts";

suite("getCommandUses — command uses extraction", () => {
	test("extracts command uses with segment", () => {
		const uses = getCommandUses("git status --short && rg foo");
		assert.equal(uses.length, 2);
		assert.equal(uses[0].name, "git");
		assert.deepEqual(uses[0].args, ["status", "--short"]);
		assert.equal(uses[1].name, "rg");
		assert.deepEqual(uses[1].args, ["foo"]);
	});

	test("empty text produces no uses", () => {
		assert.deepEqual(getCommandUses(""), []);
	});

	test("text with only whitespace produces no uses", () => {
		assert.deepEqual(getCommandUses("   \n  "), []);
	});

	test("quoted flag produces an obfuscated use", () => {
		const [use] = getCommandUses('rm "-rf" dir/');
		assert.equal(use.obfuscated, true);
	});

	test("quoted command name produces an obfuscated use", () => {
		const [use] = getCommandUses('"git" commit -m x');
		assert.equal(use.obfuscated, true);
	});

	test("quoted git subcommand-adjacent wrapper produces an obfuscated use", () => {
		const [use] = getCommandUses('"sudo" git push');
		assert.equal(use.obfuscated, true);
	});

	test("clean commands are never marked obfuscated", () => {
		const uses = getCommandUses("git status --short && rg foo");
		assert.ok(uses.every((u) => !u.obfuscated));
	});

	test("a legitimately quoted commit message is not marked obfuscated", () => {
		const [use] = getCommandUses('git commit -m "fix bug"');
		assert.equal(use.obfuscated, undefined);
		assert.equal(use.name, "git");
	});
});

suite("flagMatches — flag comparison", () => {
	test("exact match", () => assert.ok(flagMatches("-rf", "-rf")));
	test("starts with flag= form", () => assert.ok(flagMatches("--recursive=true", "--recursive")));
	test("combined short flag matches constituent single-char", () => assert.ok(flagMatches("-rfv", "-r")));
	test("combined short flag matches constituent multi-char", () => assert.ok(flagMatches("-rfv", "-rf")));
	test("combined short flag matches reversed order", () => assert.ok(flagMatches("-rf", "-fr")));
	test("combined short flag does not match unrelated char", () => assert.ok(!flagMatches("-rfv", "-l")));
	test("no match when completely different flag", () => assert.ok(!flagMatches("-rf", "-x")));
	test("long flag does not spuriously match short flag", () => assert.ok(!flagMatches("--recursive", "-r")));
	test("short flag does not spuriously match long flag", () => assert.ok(!flagMatches("-r", "--recursive")));
});

suite("commandFlags — flag extraction", () => {
	test("extracts flags only", () => {
		const use: CommandUse = { name: "git", args: ["status", "--short", "-b", "--", "file"], segment: "git status --short -b -- file" };
		assert.deepEqual(commandFlags(use), ["--short", "-b"]);
	});

	test("no flags returns empty", () => {
		const use: CommandUse = { name: "cat", args: ["file"], segment: "cat file" };
		assert.deepEqual(commandFlags(use), []);
	});

	test("-- alone is not a flag", () => {
		const use: CommandUse = { name: "git", args: ["--", "file"], segment: "git -- file" };
		assert.deepEqual(commandFlags(use), []);
	});
});

suite("matchesEntry — command matching", () => {
	test("exact command name", () => {
		const use: CommandUse = { name: "rg", args: ["foo"], segment: "rg foo" };
		assert.ok(matchesEntry(use, { name: "rg", status: CommandPolicyStatus.Allowed, command: "rg" }));
	});

	test("predicate command match", () => {
		const use: CommandUse = { name: "python3", args: ["-c", "'x'"], segment: "python3 -c 'x'" };
		assert.ok(matchesEntry(use, { name: "Python", status: CommandPolicyStatus.Banned, command: (u) => /^python(?:\d+(?:\.\d+)?)?$/.test(u.name) }));
	});

	test("predicate does not match unrelated command", () => {
		const use: CommandUse = { name: "pythonize", args: [], segment: "pythonize" };
		assert.ok(!matchesEntry(use, { name: "Python", status: CommandPolicyStatus.Banned, command: (u) => /^python(?:\d+(?:\.\d+)?)?$/.test(u.name) }));
	});

	test("predicate can match on args, not just command name", () => {
		const use: CommandUse = { name: "cp", args: ["file", ".git/x"], segment: "cp file .git/x" };
		assert.ok(
			matchesEntry(use, {
				name: "protected folder",
				status: CommandPolicyStatus.Banned,
				command: (u) => u.args.some((a) => a.includes(".git")),
			}),
		);
	});

	test("subcommand matches exact subcommand", () => {
		const use: CommandUse = { name: "git", args: ["status", "--short"], segment: "git status --short" };
		assert.ok(matchesEntry(use, { name: "git status", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["status"]], allowedFlags: ["--short"] }));
	});

	test("subcommand OR semantics matches any one sub-array", () => {
		const use: CommandUse = { name: "git", args: ["diff"], segment: "git diff" };
		assert.ok(matchesEntry(use, { name: "git", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["commit"], ["diff"], ["log"]] }));
	});

	test("subcommand no match when no sub-array fully matches", () => {
		const use: CommandUse = { name: "git", args: ["push"], segment: "git push" };
		assert.ok(!matchesEntry(use, { name: "git", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["commit"], ["diff"]] }));
	});

	test("subcommand matches when first arg matches one sub-array", () => {
		const use: CommandUse = { name: "git", args: ["config", "user.name"], segment: "git config user.name" };
		assert.ok(matchesEntry(use, { name: "git config", status: CommandPolicyStatus.Banned, command: "git", subcommand: [["config"], ["push"]] }));
	});

	test("no subcommand matches any args", () => {
		const use: CommandUse = { name: "git", args: ["anything"], segment: "git anything" };
		assert.ok(matchesEntry(use, { name: "git", status: CommandPolicyStatus.Allowed, command: "git" }));
	});

	test("command name is case-insensitive (use name is already lowercased by commandInvocation)", () => {
		const use: CommandUse = { name: "rg", args: ["foo"], segment: "rg foo" };
		assert.ok(matchesEntry(use, { name: "rg", status: CommandPolicyStatus.Allowed, command: "rg" }));
	});
});

suite("findBannedFlag — flag bans", () => {
	test("detects banned flag in combined short args (-rfv vs -rf)", () => {
		const use: CommandUse = { name: "rm", args: ["-rfv", "dir"], segment: "rm -rfv dir" };
		assert.equal(findBannedFlag(use, { name: "rm", status: CommandPolicyStatus.Allowed, command: "rm", bannedFlags: ["-rf"] }), "-rf");
	});

	test("detects banned single-char flag in combined short args (-rfv vs -r)", () => {
		const use: CommandUse = { name: "rm", args: ["-rfv", "dir"], segment: "rm -rfv dir" };
		assert.equal(findBannedFlag(use, { name: "rm", status: CommandPolicyStatus.Allowed, command: "rm", bannedFlags: ["-r"] }), "-r");
	});

	test("detects banned flag in combined short args with git checkout (-fb vs -b)", () => {
		const use: CommandUse = { name: "git", args: ["checkout", "-fb", "feature"], segment: "git checkout -fb feature" };
		assert.equal(findBannedFlag(use, { name: "git checkout", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["checkout"]], bannedFlags: ["-b", "-B"] }), "-b");
	});

	test("returns null when banned flag is absent", () => {
		const use: CommandUse = { name: "rm", args: ["file"], segment: "rm file" };
		assert.equal(findBannedFlag(use, { name: "rm", status: CommandPolicyStatus.Allowed, command: "rm", bannedFlags: ["-rf"] }), null);
	});

	test("flag=value form matches banned flag", () => {
		const use: CommandUse = { name: "git", args: ["checkout", "-b=feature"], segment: "git checkout -b=feature" };
		assert.equal(findBannedFlag(use, { name: "git checkout", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["checkout"]], bannedFlags: ["-b"] }), "-b");
	});

	test("bannedFlags empty list returns null", () => {
		const use: CommandUse = { name: "ls", args: ["-la"], segment: "ls -la" };
		assert.equal(findBannedFlag(use, { name: "ls", status: CommandPolicyStatus.Allowed, command: "ls", bannedFlags: [] }), null);
	});

	test("multiple banned flags returns first match", () => {
		const use: CommandUse = { name: "rm", args: ["-rf", "--recursive", "dir"], segment: "rm -rf --recursive dir" };
		// -r appears first in bannedFlags; with combined-flag matching, -rf
		// contains -r's character, so -r is the first match.
		assert.equal(findBannedFlag(use, { name: "rm", status: CommandPolicyStatus.Allowed, command: "rm", bannedFlags: ["-r", "-rf", "--recursive"] }), "-r");
	});

	test("no bannedFlags on entry returns null", () => {
		const use: CommandUse = { name: "ls", args: ["-la"], segment: "ls -la" };
		assert.equal(findBannedFlag(use, { name: "ls", status: CommandPolicyStatus.Allowed, command: "ls" }), null);
	});
});

suite("findDisallowedFlag — allowed flags enforcement", () => {
	test("detects flag outside allowed set", () => {
		const use: CommandUse = { name: "git", args: ["status", "-v"], segment: "git status -v" };
		assert.equal(findDisallowedFlag(use, { name: "git status", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["status"]], allowedFlags: ["--short", "--porcelain"] }), "-v");
	});

	test("passes when only allowed flags are present", () => {
		const use: CommandUse = { name: "git", args: ["status", "--short"], segment: "git status --short" };
		assert.equal(findDisallowedFlag(use, { name: "git status", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["status"]], allowedFlags: ["--short", "--porcelain"] }), null);
	});

	test("no allowedFlags on entry returns null", () => {
		const use: CommandUse = { name: "rg", args: ["foo"], segment: "rg foo" };
		assert.equal(findDisallowedFlag(use, { name: "rg", status: CommandPolicyStatus.Allowed, command: "rg" }), null);
	});

	test("allowed flag with =value form is accepted", () => {
		const use: CommandUse = { name: "git", args: ["status", "--porcelain=v1"], segment: "git status --porcelain=v1" };
		assert.equal(findDisallowedFlag(use, { name: "git status", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["status"]], allowedFlags: ["--porcelain"] }), null);
	});

	test("-- alone is not flagged even if not in allowed set", () => {
		const use: CommandUse = { name: "git", args: ["status", "--"], segment: "git status --" };
		assert.equal(findDisallowedFlag(use, { name: "git status", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["status"]], allowedFlags: ["--short"] }), null);
	});

	test("multiple flags first disallowed is reported", () => {
		const use: CommandUse = { name: "git", args: ["status", "-v", "-b"], segment: "git status -v -b" };
		assert.equal(findDisallowedFlag(use, { name: "git status", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["status"]], allowedFlags: ["--short"] }), "-v");
	});

	test("combined short flag cannot smuggle a disallowed char past an allowed one (-sv vs -s)", () => {
		const use: CommandUse = { name: "git", args: ["status", "-sv"], segment: "git status -sv" };
		assert.equal(findDisallowedFlag(use, { name: "git status", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["status"]], allowedFlags: ["--short", "--porcelain", "-s"] }), "-sv");
	});

	test("combined short flag passes when every char is individually allowed", () => {
		const use: CommandUse = { name: "git", args: ["status", "-sb"], segment: "git status -sb" };
		assert.equal(findDisallowedFlag(use, { name: "git status", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["status"]], allowedFlags: ["-s", "-b"] }), null);
	});

	test("combined short flag cannot smuggle a disallowed char behind =value (-sv=val vs -s)", () => {
		const use: CommandUse = { name: "git", args: ["status", "-sv=val"], segment: "git status -sv=val" };
		assert.equal(findDisallowedFlag(use, { name: "git status", status: CommandPolicyStatus.Allowed, command: "git", subcommand: [["status"]], allowedFlags: ["--short", "--porcelain", "-s"] }), "-sv=val");
	});
});

suite("evaluateCommand — end-to-end policy decision", () => {
	const testEntries: CommandPolicyEntry[] = [
		{ name: "rg", status: CommandPolicyStatus.Allowed, command: "rg" },
		{ name: "rm", status: CommandPolicyStatus.Allowed, command: "rm", bannedFlags: ["-rf"] },
		{
			name: "git status",
			status: CommandPolicyStatus.Allowed,
			command: "git",
			subcommand: [["status"]],
			allowedFlags: ["--short"],
		},
		{
			name: "git push",
			status: CommandPolicyStatus.Allowed,
			command: "git",
			subcommand: [["push"]],
			validate: (use) => (use.args.includes("--force") ? "force pushes are not allowed" : null),
		},
		{ name: "curl", status: CommandPolicyStatus.Banned, command: "curl" },
	];

	test("fully allowed command returns null", () => {
		assert.equal(evaluateCommand("rg foo", testEntries), null);
	});

	test("here-doc is blocked before any command is inspected", () => {
		const violation = evaluateCommand("cat <<EOF\nhi\nEOF", testEntries);
		assert.match(violation?.reason ?? "", /Here-docs/);
	});

	test("obfuscated command is blocked", () => {
		const violation = evaluateCommand('"rg" foo', testEntries);
		assert.match(violation?.reason ?? "", /pointlessly quoted or backslash-escaped/);
	});

	test("command not on the allow list is blocked", () => {
		const violation = evaluateCommand("wget foo", testEntries);
		assert.match(violation?.reason ?? "", /not on the allow list/);
	});

	test("banned entry is blocked", () => {
		const violation = evaluateCommand("curl example.com", testEntries);
		assert.match(violation?.reason ?? "", /curl is banned/);
	});

	test("banned flag is blocked", () => {
		const violation = evaluateCommand("rm -rf dir", testEntries);
		assert.match(violation?.reason ?? "", /Flag `-rf` is not allowed/);
	});

	test("disallowed flag is blocked", () => {
		const violation = evaluateCommand("git status -v", testEntries);
		assert.match(violation?.reason ?? "", /not in the allowed flags/);
	});

	test("entry-specific validation failure is blocked", () => {
		const violation = evaluateCommand("git push --force", testEntries);
		assert.match(violation?.reason ?? "", /force pushes are not allowed/);
	});

	test("second command use in a chain is checked too", () => {
		const violation = evaluateCommand("rg foo && wget bar", testEntries);
		assert.match(violation?.reason ?? "", /not on the allow list/);
	});

	test("a former wrapper command is checked as its own name, not seen through", () => {
		// xargs (and env, nice, nohup, …) are no longer transparent: they are just
		// ordinary command names, denied unless explicitly allowed. That closes the
		// bypass where an unlisted wrapper could front for a banned command.
		const violation = evaluateCommand("xargs rg foo", testEntries);
		assert.match(violation?.reason ?? "", /not on the allow list/);
	});

	const entriesWithEcho: CommandPolicyEntry[] = [...testEntries, { name: "echo", status: CommandPolicyStatus.Allowed, command: "echo" }];

	test("banned command hidden via command substitution inside double quotes is still caught", () => {
		// A shell still runs $(...) inside double quotes — a bypass here would let
		// a banned command slip through disguised as an argument to an allowed one.
		const violation = evaluateCommand('echo "$(curl example.com)"', entriesWithEcho);
		assert.match(violation?.reason ?? "", /curl is banned/);
	});

	test("benign command substitution inside double quotes produces no false positive", () => {
		assert.equal(evaluateCommand('echo "$(rg foo)"', entriesWithEcho), null);
	});
});
