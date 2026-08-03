import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { CommandPolicyEntry } from "@vt-agent/command-policy";

const AGENT_NAME = /^[a-z][a-z0-9_]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_-]*$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FRONTMATTER_FIELDS = new Set([
  "name",
  "label",
  "description",
  "model",
  "thinking",
  "prompt",
  "tools",
  "subagents",
  "command_policy",
  "maxTurns",
]);

export type SubagentThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface SubagentDefinition {
  name: string;
  label: string;
  description: string;
  model: string;
  thinking: SubagentThinkingLevel;
  prompt: string;
  tools: string[];
  subagents: string[];
  commandPolicy: CommandPolicyEntry[];
  commandPolicySource?: string;
  maxTurns?: number;
  systemPrompt: string;
  filePath: string;
}

function definitionError(filePath: string, message: string): Error {
  return new Error(`Invalid sub-agent definition ${filePath}: ${message}`);
}

function requiredString(
  frontmatter: Record<string, unknown>,
  field: string,
  filePath: string,
): string {
  const value = frontmatter[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw definitionError(filePath, `frontmatter field '${field}' must be a non-empty string`);
  }
  return value.trim();
}

const COMMAND_POLICY_FIELDS = new Set([
  "name",
  "status",
  "command",
  "subcommand",
  "description",
  "bannedFlags",
  "allowedFlags",
]);

function stringArray(
  value: unknown,
  field: string,
  filePath: string,
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    const qualifier = allowEmpty ? "a string array" : "a non-empty string array";
    throw definitionError(filePath, `'${field}' must be ${qualifier}`);
  }
  return value.map((item) => item.trim());
}

function parseSubagentNames(value: unknown, filePath: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw definitionError(filePath, "frontmatter field 'subagents' must be an array");
  }

  const names = new Set<string>();
  return value.map((rawName) => {
    if (typeof rawName !== "string" || !AGENT_NAME.test(rawName)) {
      throw definitionError(filePath, `'${String(rawName)}' is not a valid sub-agent name`);
    }
    if (names.has(rawName)) {
      throw definitionError(filePath, `sub-agent '${rawName}' is listed more than once`);
    }
    names.add(rawName);
    return rawName;
  });
}

function parseCommandPolicy(
  value: unknown,
  filePath: string,
): { entries: CommandPolicyEntry[]; source?: string } {
  if (value === undefined) return { entries: [] };
  if (typeof value === "string" && value.trim() !== "") {
    return { entries: [], source: value.trim() };
  }
  if (!Array.isArray(value)) {
    throw definitionError(
      filePath,
      "frontmatter field 'command_policy' must be an array or a named policy",
    );
  }

  return {
    entries: value.map((rawEntry, index) => {
      const field = `command_policy[${index}]`;
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        throw definitionError(filePath, `'${field}' must be an object`);
      }
      const entry = rawEntry as Record<string, unknown>;
      for (const key of Object.keys(entry)) {
        if (!COMMAND_POLICY_FIELDS.has(key)) {
          throw definitionError(filePath, `unknown field '${field}.${key}'`);
        }
      }

      const name = requiredString(entry, "name", filePath);
      const command = requiredString(entry, "command", filePath);
      const status = requiredString(entry, "status", filePath);
      if (status !== "allowed" && status !== "banned") {
        throw definitionError(filePath, `'${field}.status' must be 'allowed' or 'banned'`);
      }

      const descriptionValue = entry.description;
      const description =
        descriptionValue === undefined ? undefined : requiredString(entry, "description", filePath);
      const subcommandValue = entry.subcommand;
      const subcommand =
        subcommandValue === undefined
          ? undefined
          : Array.isArray(subcommandValue) && subcommandValue.length > 0
            ? subcommandValue.map((part, partIndex) =>
                stringArray(part, `${field}.subcommand[${partIndex}]`, filePath),
              )
            : (() => {
                throw definitionError(
                  filePath,
                  `'${field}.subcommand' must be a non-empty array of string arrays`,
                );
              })();
      const bannedFlags =
        entry.bannedFlags === undefined
          ? undefined
          : stringArray(entry.bannedFlags, `${field}.bannedFlags`, filePath, true);
      const allowedFlags =
        entry.allowedFlags === undefined
          ? undefined
          : stringArray(entry.allowedFlags, `${field}.allowedFlags`, filePath, true);

      const base = {
        name,
        command,
        ...(subcommand ? { subcommand } : {}),
        ...(description ? { description } : {}),
      };
      if (status === "banned") {
        if (bannedFlags || allowedFlags) {
          throw definitionError(filePath, `'${field}' cannot set flags when status is 'banned'`);
        }
        return { ...base, status };
      }
      if (bannedFlags && allowedFlags) {
        throw definitionError(filePath, `'${field}' cannot set both bannedFlags and allowedFlags`);
      }
      if (allowedFlags) return { ...base, status, allowedFlags };
      if (bannedFlags) return { ...base, status, bannedFlags };
      return { ...base, status };
    }),
  };
}

export function parseSubagentDefinition(content: string, filePath: string): SubagentDefinition {
  const { frontmatter, body } = parseFrontmatter(content);

  for (const field of Object.keys(frontmatter)) {
    if (!FRONTMATTER_FIELDS.has(field)) {
      throw definitionError(filePath, `unknown frontmatter field '${field}'`);
    }
  }

  const name = requiredString(frontmatter, "name", filePath);
  if (!AGENT_NAME.test(name)) {
    throw definitionError(
      filePath,
      "frontmatter field 'name' must contain lowercase letters, numbers, or underscores",
    );
  }

  const thinking = requiredString(frontmatter, "thinking", filePath);
  if (!THINKING_LEVELS.has(thinking)) {
    throw definitionError(filePath, `unsupported thinking level '${thinking}'`);
  }

  const tools = requiredString(frontmatter, "tools", filePath)
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (tools.length === 0) {
    throw definitionError(filePath, "frontmatter field 'tools' must not be empty");
  }
  const uniqueTools = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool)) {
      throw definitionError(filePath, `tool '${tool}' is not a valid tool name`);
    }
    if (uniqueTools.has(tool)) {
      throw definitionError(filePath, `tool '${tool}' is listed more than once`);
    }
    uniqueTools.add(tool);
  }

  const rawMaxTurns = frontmatter.maxTurns;
  const maxTurns =
    rawMaxTurns === undefined
      ? undefined
      : typeof rawMaxTurns === "number"
        ? rawMaxTurns
        : typeof rawMaxTurns === "string" && /^[1-9]\d*$/.test(rawMaxTurns)
          ? Number(rawMaxTurns)
          : Number.NaN;
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns <= 0)) {
    throw definitionError(filePath, "frontmatter field 'maxTurns' must be a positive integer");
  }

  const commandPolicy = parseCommandPolicy(frontmatter.command_policy, filePath);
  const systemPrompt = body.trim();
  if (systemPrompt === "") {
    throw definitionError(filePath, "Markdown body must contain the system prompt");
  }

  return {
    name,
    label: requiredString(frontmatter, "label", filePath),
    description: requiredString(frontmatter, "description", filePath),
    model: requiredString(frontmatter, "model", filePath),
    thinking: thinking as SubagentThinkingLevel,
    prompt: requiredString(frontmatter, "prompt", filePath),
    tools,
    subagents: parseSubagentNames(frontmatter.subagents, filePath),
    commandPolicy: commandPolicy.entries,
    ...(commandPolicy.source === undefined ? {} : { commandPolicySource: commandPolicy.source }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    systemPrompt,
    filePath,
  };
}

export function validateSubagentDefinitions(definitions: SubagentDefinition[]): void {
  const byName = new Map<string, SubagentDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw definitionError(definition.filePath, `duplicate agent name '${definition.name}'`);
    }
    byName.set(definition.name, definition);
  }

  for (const definition of definitions) {
    for (const child of definition.subagents) {
      if (!byName.has(child)) {
        throw definitionError(definition.filePath, `unknown nested sub-agent '${child}'`);
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string, path: string[]): void => {
    if (visiting.has(name)) {
      throw definitionError(
        byName.get(name)!.filePath,
        `nested sub-agent cycle: ${[...path, name].join(" -> ")}`,
      );
    }
    if (visited.has(name)) return;

    visiting.add(name);
    const definition = byName.get(name)!;
    for (const child of definition.subagents) visit(child, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  };

  for (const definition of definitions) visit(definition.name, []);
}

export function loadSubagentDefinitions(paths: readonly (string | URL)[]): SubagentDefinition[] {
  const definitions = paths.map((path) => {
    const filePath = path instanceof URL ? fileURLToPath(path) : path;
    if (!filePath.endsWith(".md")) {
      throw definitionError(filePath, "definition path must end with '.md'");
    }
    return parseSubagentDefinition(readFileSync(filePath, "utf8"), filePath);
  });

  validateSubagentDefinitions(definitions);
  return definitions;
}
