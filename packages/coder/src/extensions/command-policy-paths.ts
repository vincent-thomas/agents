import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import type { CommandPolicyCommandValidator } from "@vt-agent/command-policy";

interface ProjectPathOptions {
  allowEmpty: boolean;
  relativeOnly: boolean;
}

const ACTIVE_SHELL_PATH_CHARACTERS = "$`*?[]{}~<>";

function parseLiteralShellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (quote === '"' && (character === "$" || character === "`")) {
        return null;
      } else {
        current += character;
      }
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (character === "#" && !started) return null;
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      index++;
      if (index >= command.length) return null;
      current += command[index];
      started = true;
      continue;
    }
    if (ACTIVE_SHELL_PATH_CHARACTERS.includes(character)) return null;
    current += character;
    started = true;
  }

  if (quote) return null;
  if (started) words.push(current);
  return words;
}

export const validateManagedBunCommand: CommandPolicyCommandValidator = (command, uses, cwd) => {
  const managedBunUse = uses.find(
    (use) =>
      use.name === "bun" &&
      (use.args[0]?.toLowerCase() === "test" ||
        (use.args[0]?.toLowerCase() === "x" && use.args[1]?.toLowerCase() === "oxfmt")),
  );
  if (!managedBunUse) return null;

  const trimmedCommand = command.trim();
  const words = parseLiteralShellWords(trimmedCommand);
  if (uses.length !== 1 || trimmedCommand !== managedBunUse.segment || words?.[0] !== "bun") {
    return "Managed Bun commands must run standalone without environment prefixes, substitutions, redirections, or command chaining.";
  }

  const args = words.slice(1);
  if (args[0]?.toLowerCase() === "test") {
    return validateProjectPaths(args.slice(1), { allowEmpty: true, relativeOnly: true }, cwd);
  }

  const mode = args[2];
  if (mode !== "--check" && mode !== "--write") {
    return "Only --check or --write is allowed.";
  }
  return validateProjectPaths(args.slice(3), { allowEmpty: false, relativeOnly: false }, cwd);
};

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function lexicallyEscapesRoot(candidate: string): boolean {
  if (isAbsolute(candidate)) return candidate.split(sep).includes("..");

  let depth = 0;
  for (const component of candidate.split(sep)) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (depth === 0) return true;
      depth--;
    } else {
      depth++;
    }
  }
  return false;
}

function realpathPreservingTraversal(root: string, candidate: string): string {
  const candidateRoot = isAbsolute(candidate) ? parse(candidate).root : "";
  let current = candidateRoot || root;
  let enteredRoot = !candidateRoot;
  const remainder = candidateRoot ? candidate.slice(candidateRoot.length) : candidate;

  for (const component of remainder.split(sep)) {
    if (component === "" || component === ".") {
      if (!statSync(current).isDirectory()) throw new Error("Cannot traverse through a file");
      continue;
    }
    if (component === "..") {
      if (!statSync(current).isDirectory()) throw new Error("Cannot traverse through a file");
      current = dirname(current);
    } else {
      current = realpathSync(join(current, component));
    }

    if (isInside(root, current)) {
      enteredRoot = true;
    } else if (enteredRoot) {
      throw new Error("Path traversal left the project");
    }
  }
  return current;
}

export function validateProjectPaths(
  paths: string[],
  options: ProjectPathOptions,
  cwd: string,
): string | null {
  if (paths.length === 0) {
    return options.allowEmpty ? null : "At least one explicit project path is required.";
  }

  const projectRoot = realpathSync(cwd);
  for (const candidate of paths) {
    if (candidate.length === 0) {
      return "Paths cannot be empty.";
    }
    if (candidate.startsWith("-")) {
      return `Unexpected flag \`${candidate}\`; only paths are allowed.`;
    }
    if (options.relativeOnly && isAbsolute(candidate)) {
      return `Path \`${candidate}\` must be relative to the project root.`;
    }
    if (lexicallyEscapesRoot(candidate)) {
      return `Path \`${candidate}\` cannot traverse outside the project.`;
    }

    let target: string;
    try {
      target = realpathPreservingTraversal(projectRoot, candidate);
    } catch {
      return `Path \`${candidate}\` must reference an existing project path.`;
    }

    if (!isInside(projectRoot, target)) {
      return `Path \`${candidate}\` resolves outside the project.`;
    }
  }

  return null;
}
