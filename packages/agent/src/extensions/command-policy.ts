/**
 * command-policy extension
 *
 * Allows only approved shell commands in the bash tool.
 */

import {
  CommandPolicyStatus,
  createCommandPolicyExtension,
} from "@vt-agent/command-policy";
import {
  isAwkCommand,
  isPerlCommand,
  isPythonCommand,
} from "./command-policy-predicates.ts";

export default createCommandPolicyExtension({
  entries: [
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
      name: "cargo",
      status: CommandPolicyStatus.Allowed,
      command: "cargo",
      subcommand: [["bench"]],
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
      name: "Python",
      status: CommandPolicyStatus.Banned,
      command: (use) => isPythonCommand(use.name),
      description:
        "Use safer shell tools or Pi tools instead. For JSON, prefer jq.",
    },
    {
      name: "Perl",
      status: CommandPolicyStatus.Banned,
      command: (use) => isPerlCommand(use.name),
      description:
        "Use safer shell tools or Pi tools instead. For JSON, prefer jq.",
    },
    {
      name: "awk",
      status: CommandPolicyStatus.Banned,
      command: (use) => isAwkCommand(use.name),
      description:
        "Use the read tool with offset/limit, or simpler tools like head, tail, wc, or rg.",
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
      name: "rm",
      status: CommandPolicyStatus.Allowed,
      command: "rm",
      bannedFlags: ["-r", "-R", "-rf", "-fr", "--recursive"],
    },
    {
      name: "cp",
      status: CommandPolicyStatus.Allowed,
      command: "cp",
      bannedFlags: [
        "-r",
        "-R",
        "--recursive",
        "-a",
        "--archive",
        "-t",
        "--target-directory",
      ],
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
      allowedFlags: ["--short", "--porcelain", "-s"],
    },
    {
      name: "git branch",
      status: CommandPolicyStatus.Banned,
      command: "git",
      subcommand: [["branch"]],
      description:
        "Use the git_commit or push_and_check_ci tools for branch management.",
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
      description:
        "Do not run git commit directly in bash. Use the git_commit tool instead.",
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
      description:
        "Recursive git rm is not allowed. Remove files individually instead.",
    },
    {
      name: "git checkout",
      status: CommandPolicyStatus.Allowed,
      command: "git",
      subcommand: [["checkout"]],
      bannedFlags: ["-b", "-B", "--orphan"],
    },
  ],
});
