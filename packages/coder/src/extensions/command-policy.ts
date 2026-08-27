/**
 * command-policy extension
 *
 * Allows only approved shell commands in the bash tool.
 */

import {
  CommandPolicyStatus,
  createCommandPolicyExtension,
  type CommandPolicyEntry,
  type CommandUse,
} from "@vt-agent/command-policy";
import { validateManagedBunCommand } from "./command-policy-paths.ts";

const ghReadOnlySubcommands = new Set([
  "alias list",
  "attestation trusted-root",
  "attestation verify",
  "auth status",
  "auth token",
  "cache list",
  "codespace list",
  "codespace logs",
  "codespace view",
  "completion",
  "config get",
  "config list",
  "extension browse",
  "extension list",
  "extension search",
  "gist list",
  "gist view",
  "gpg-key list",
  "issue list",
  "issue status",
  "issue view",
  "label list",
  "org list",
  "pr checks",
  "pr diff",
  "pr list",
  "pr status",
  "pr view",
  "project field-list",
  "project item-list",
  "project list",
  "project view",
  "release list",
  "release verify",
  "release verify-asset",
  "release view",
  "repo list",
  "repo view",
  "ruleset check",
  "ruleset list",
  "ruleset view",
  "run list",
  "run view",
  "run watch",
  "search code",
  "search commits",
  "search issues",
  "search prs",
  "search repos",
  "search users",
  "secret list",
  "ssh-key list",
  "stack view",
  "status",
  "variable list",
  "workflow list",
  "workflow view",
]);

const ghReadOnlyNestedSubcommands = new Set([
  "repo autolink get",
  "repo autolink list",
  "repo deploy-key list",
  "repo gitignore list",
  "repo license list",
]);
const ghBuiltinCommands = new Set([
  "alias",
  "api",
  "attestation",
  "auth",
  "browse",
  "cache",
  "codespace",
  "completion",
  "config",
  "extension",
  "gist",
  "gpg-key",
  "help",
  "issue",
  "label",
  "org",
  "pr",
  "project",
  "release",
  "repo",
  "ruleset",
  "run",
  "search",
  "secret",
  "ssh-key",
  "stack",
  "status",
  "variable",
  "workflow",
]);
const ghOptionsWithValues = new Set(["--repo", "-R", "--hostname"]);
const ghApiReadMethods = new Set(["get", "head", "options"]);

function ghPositionals(args: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-")) positionals.push(arg);
    if (!arg.includes("=") && ghOptionsWithValues.has(arg)) index++;
  }
  return positionals.map((arg) => arg.toLowerCase());
}

function ghApiMethods(args: string[]): string[] {
  const methods: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index].toLowerCase();
    if (arg.startsWith("--method=")) methods.push(arg.slice("--method=".length));
    else if (arg.startsWith("-x") && arg.length > 2) methods.push(arg.slice(2));
    else if (arg === "--method" || arg === "-x") methods.push(args[++index]?.toLowerCase() ?? "");
  }
  return methods;
}

function isReadOnlyGhApi(args: string[]): boolean {
  const methods = ghApiMethods(args);
  if (methods.some((method) => !ghApiReadMethods.has(method))) return false;

  if (ghPositionals(args)[1] === "graphql") {
    const joinedArgs = args.join(" ");
    if (!/(?:^|\s)(?:-f|-F|--field|--raw-field)?=?query=/i.test(joinedArgs)) return false;
    if (/query=@/i.test(joinedArgs)) return false;
    return !/\bmutation(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*(?:\([^)]*\))?\s*\{/i.test(joinedArgs);
  }

  if (methods.length > 0) return true;
  return !args.some(
    (arg) =>
      /^(?:-f|-F)(?:[^-]|$)/.test(arg) || /^(?:--field|--raw-field|--input)(?:=|$)/.test(arg),
  );
}

function isReadOnlyGhCommand(use: CommandUse): boolean {
  if (use.name !== "gh") return false;
  const [command, subcommand, nestedSubcommand] = ghPositionals(use.args);
  if (!command) return true;
  if (command === "help") return true;
  if (use.args.some((arg) => ["--help", "-h"].includes(arg)) && ghBuiltinCommands.has(command)) {
    return true;
  }
  if (command === "api") return isReadOnlyGhApi(use.args);
  if (command === "codespace" && subcommand === "ports") return nestedSubcommand !== "visibility";
  return (
    ghReadOnlySubcommands.has([command, subcommand].filter(Boolean).join(" ")) ||
    ghReadOnlyNestedSubcommands.has(
      [command, subcommand, nestedSubcommand].filter(Boolean).join(" "),
    )
  );
}

export const commandPolicyEntries: CommandPolicyEntry[] = [
  {
    name: "sudo",
    status: CommandPolicyStatus.Banned,
    command: "sudo",
    description: "It is banned to try to gain superuser access",
  },
  {
    name: "doas",
    status: CommandPolicyStatus.Banned,
    command: "doas",
    description: "It is banned to try to gain superuser access",
  },
  {
    name: "cat",
    status: CommandPolicyStatus.Banned,
    command: "cat",
    description: "Use the read tool to view file contents.",
  },
  {
    name: "grep",
    status: CommandPolicyStatus.Banned,
    command: "grep",
    description: "Use rg for searching instead.",
  },
  {
    name: "find",
    status: CommandPolicyStatus.Banned,
    command: "find",
    description: "Use fd for file discovery instead.",
  },
  {
    name: "tee",
    status: CommandPolicyStatus.Banned,
    command: "tee",
    description: "Use the write or edit tool to write file contents.",
  },
  {
    name: "sed",
    status: CommandPolicyStatus.Banned,
    command: "sed",
    description: "Use the edit tool for find-and-replace edits.",
  },
  {
    name: "read-only gh command",
    status: CommandPolicyStatus.Allowed,
    command: isReadOnlyGhCommand,
  },
  {
    name: "unmanaged gh operation",
    status: CommandPolicyStatus.Banned,
    command: "gh",
    description: "Only read-only GitHub CLI operations are allowed in bash.",
  },
  {
    name: "rm",
    status: CommandPolicyStatus.Banned,
    command: "rm",
    description: "Use git rm to remove tracked files instead.",
  },
  { name: "ls", status: CommandPolicyStatus.Allowed, command: "ls" },
  { name: "pwd", status: CommandPolicyStatus.Allowed, command: "pwd" },
  { name: "echo", status: CommandPolicyStatus.Allowed, command: "echo" },
  { name: "head", status: CommandPolicyStatus.Allowed, command: "head" },
  { name: "tail", status: CommandPolicyStatus.Allowed, command: "tail" },
  { name: "wc", status: CommandPolicyStatus.Allowed, command: "wc" },
  { name: "sort", status: CommandPolicyStatus.Allowed, command: "sort" },
  { name: "uniq", status: CommandPolicyStatus.Allowed, command: "uniq" },
  { name: "rg", status: CommandPolicyStatus.Allowed, command: "rg" },
  { name: "fd", status: CommandPolicyStatus.Allowed, command: "fd" },
  { name: "jq", status: CommandPolicyStatus.Allowed, command: "jq" },
  { name: "true", status: CommandPolicyStatus.Allowed, command: "true" },
  { name: "false", status: CommandPolicyStatus.Allowed, command: "false" },
  { name: "test", status: CommandPolicyStatus.Allowed, command: "test" },
  { name: "mkdir", status: CommandPolicyStatus.Allowed, command: "mkdir" },
  {
    name: "cp",
    status: CommandPolicyStatus.Allowed,
    command: "cp",
    bannedFlags: ["-r", "-R", "--recursive", "-a", "--archive", "-t", "--target-directory"],
  },
  {
    name: "mv",
    status: CommandPolicyStatus.Allowed,
    command: "mv",
    bannedFlags: ["-t", "--target-directory"],
  },
  {
    name: "chmod",
    status: CommandPolicyStatus.Allowed,
    command: "chmod",
    bannedFlags: ["-R", "--recursive"],
  },
  {
    name: "nix",
    status: CommandPolicyStatus.Allowed,
    command: "nix",
    subcommand: [["build"], ["flake", "check"], ["log"]],
  },
  {
    name: "git config",
    status: CommandPolicyStatus.Banned,
    command: "git",
    subcommand: [["config"]],
    description: "Do not inspect or modify Git configuration from Pi.",
  },
  {
    name: "git status",
    status: CommandPolicyStatus.Allowed,
    command: "git",
    subcommand: [["status"]],
    allowedFlags: ["--short", "--porcelain", "--branch", "-s"],
  },
  {
    name: "git branch",
    status: CommandPolicyStatus.Banned,
    command: "git",
    subcommand: [["branch"]],
    description: "Use the git_commit or push_and_check_ci tools for branch management.",
  },
  {
    name: "git push",
    status: CommandPolicyStatus.Banned,
    command: "git",
    subcommand: [["push"]],
    description:
      "Do not run git push directly in bash. Use the push_and_check_ci tool instead — it pushes your code and automatically waits for CI checks to complete.",
  },
  {
    name: "git commit",
    status: CommandPolicyStatus.Banned,
    command: "git",
    subcommand: [["commit"]],
    description: "Do not run git commit directly in bash. Use the git_commit tool instead.",
  },
  {
    name: "git",
    status: CommandPolicyStatus.Allowed,
    command: "git",
    subcommand: [
      ["diff"],
      ["log"],
      ["show"],
      ["ls-files"],
      ["add"],
      ["restore"],
      ["rev-parse"],
      ["merge-base"],
    ],
  },
  {
    name: "git rm",
    status: CommandPolicyStatus.Allowed,
    command: "git",
    subcommand: [["rm"]],
    bannedFlags: ["-r", "-R", "-rf", "-fr", "--recursive"],
    description: "Recursive git rm is not allowed. Remove files individually instead.",
  },
  {
    name: "git checkout",
    status: CommandPolicyStatus.Banned,
    command: "git",
    subcommand: [["checkout"]],
    description: "The host owns the agent branch. Use git restore for file restoration.",
  },
  {
    name: "unmanaged git operation",
    status: CommandPolicyStatus.Banned,
    command: "git",
    description:
      "Git history, refs, synchronization, and branch lifecycle are owned by dedicated tools.",
  },
  {
    name: "bun test",
    status: CommandPolicyStatus.Allowed,
    command: "bun",
    subcommand: [["test"]],
  },
  {
    name: "bun x oxfmt",
    status: CommandPolicyStatus.Allowed,
    command: "bun",
    subcommand: [["x", "oxfmt"]],
  },
  {
    name: "make, make test, or make format",
    status: CommandPolicyStatus.Allowed,
    command: (use) =>
      use.name === "make" &&
      (use.args.length === 0 ||
        (use.args.length === 1 && ["test", "format"].includes(use.args[0]))),
  },
];

export default createCommandPolicyExtension({
  entries: commandPolicyEntries,
  validateCommand: validateManagedBunCommand,
});
