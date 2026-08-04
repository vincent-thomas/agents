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
  "available_to",
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
  inheritTools: boolean;
  availableToRoot: boolean;
  availableToSubagents: string[];
  commandPolicy: CommandPolicyEntry[];
  inheritCommandPolicy: boolean;
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

const AVAILABLE_TO_FIELDS = new Set(["root", "subagents"]);

function parseAvailability(
  value: unknown,
  filePath: string,
): { root: boolean; subagents: string[] } {
  if (value === undefined) return { root: true, subagents: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw definitionError(filePath, "frontmatter field 'available_to' must be an object");
  }

  const availableTo = value as Record<string, unknown>;
  for (const field of Object.keys(availableTo)) {
    if (!AVAILABLE_TO_FIELDS.has(field)) {
      throw definitionError(filePath, `unknown field 'available_to.${field}'`);
    }
  }

  const root = availableTo.root ?? true;
  if (typeof root !== "boolean") {
    throw definitionError(filePath, "'available_to.root' must be a boolean");
  }

  const rawSubagents = availableTo.subagents ?? [];
  if (!Array.isArray(rawSubagents)) {
    throw definitionError(filePath, "'available_to.subagents' must be a string array");
  }
  const names = new Set<string>();
  const subagents = rawSubagents.map((rawName) => {
    if (typeof rawName !== "string" || !AGENT_NAME.test(rawName)) {
      throw definitionError(filePath, `'${String(rawName)}' is not a valid sub-agent name`);
    }
    if (names.has(rawName)) {
      throw definitionError(filePath, `sub-agent '${rawName}' is listed more than once`);
    }
    names.add(rawName);
    return rawName;
  });

  return { root, subagents };
}

function parseCommandPolicy(
  value: unknown,
  filePath: string,
): { entries: CommandPolicyEntry[]; inherit: boolean } {
  if (value === "inherit") return { entries: [], inherit: true };
  if (value === undefined) return { entries: [], inherit: false };
  if (!Array.isArray(value)) {
    throw definitionError(
      filePath,
      "frontmatter field 'command_policy' must be an array or 'inherit'",
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
    inherit: false,
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

  const rawTools = requiredString(frontmatter, "tools", filePath);
  const inheritTools = rawTools === "inherit";
  const tools = inheritTools
    ? []
    : rawTools
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
  if (!inheritTools && tools.length === 0) {
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

  const availability = parseAvailability(frontmatter.available_to, filePath);
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
    inheritTools,
    availableToRoot: availability.root,
    availableToSubagents: availability.subagents,
    commandPolicy: commandPolicy.entries,
    inheritCommandPolicy: commandPolicy.inherit,
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

  const calleesByCaller = new Map(
    definitions.map((definition) => [definition.name, [] as string[]]),
  );
  for (const definition of definitions) {
    for (const caller of definition.availableToSubagents) {
      if (!byName.has(caller)) {
        throw definitionError(definition.filePath, `unknown available sub-agent '${caller}'`);
      }
      calleesByCaller.get(caller)!.push(definition.name);
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string, path: string[]): void => {
    if (visiting.has(name)) {
      throw definitionError(
        byName.get(name)!.filePath,
        `sub-agent availability cycle: ${[...path, name].join(" -> ")}`,
      );
    }
    if (visited.has(name)) return;

    visiting.add(name);
    for (const child of calleesByCaller.get(name)!) visit(child, [...path, name]);
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
