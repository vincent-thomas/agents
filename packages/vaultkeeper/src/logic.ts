export const READ_ONLY_OBSIDIAN_COMMANDS = [
  "help",
  "version",
  "search",
  "search:context",
  "read",
  "files",
  "folders",
  "tags",
  "backlinks",
  "links",
  "unresolved",
  "orphans",
  "deadends",
  "properties",
  "outline",
  "tasks",
  "aliases",
  "bookmarks",
  "recents",
] as const;

export type ReadOnlyObsidianCommand = (typeof READ_ONLY_OBSIDIAN_COMMANDS)[number];

const VAULT_ARGUMENT = /^-{0,2}vault(?:=|$)/i;

export function buildObsidianArgs(
  vaultName: string,
  command: ReadOnlyObsidianCommand,
  args: readonly string[],
): string[] {
  if (!vaultName.trim()) {
    throw new Error("The Obsidian vault name cannot be empty.");
  }
  if (vaultName.includes("\0")) {
    throw new Error("The Obsidian vault name cannot contain null bytes.");
  }

  for (const arg of args) {
    if (arg.includes("\0")) {
      throw new Error("Obsidian CLI arguments cannot contain null bytes.");
    }
    if (VAULT_ARGUMENT.test(arg)) {
      throw new Error("Vault selection cannot be overridden through tool arguments.");
    }
  }

  if (command === "help" || command === "version") return [command, ...args];
  return [`vault=${vaultName}`, command, ...args];
}

export function formatObsidianOutput(stdout: string, stderr: string): string {
  const output = stdout.trim();
  const warnings = stderr.trim();

  if (output && warnings) return `${output}\n\nCLI warnings:\n${warnings}`;
  if (output) return output;
  if (warnings) return warnings;
  return "The Obsidian CLI returned no output.";
}
