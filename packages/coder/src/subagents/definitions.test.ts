import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadSubagentDefinitions,
  parseSubagentDefinition,
  validateSubagentDefinitions,
} from "./definitions.ts";

const validDefinition = `---
name: scout
label: Scout
description: Scout a codebase
model: openai-codex/gpt-5.6-luna
thinking: low
prompt: parent
tools: read, grep, find, ls
subagents: []
maxTurns: 15
---

You are a read-only codebase scout.
`;

test("loads definitions from an explicit list of Markdown paths", () => {
  const definitions = loadSubagentDefinitions([
    new URL("../../agents/scout.md", import.meta.url),
    new URL("../../agents/merge-conflicts.md", import.meta.url),
    new URL("../../agents/right-hand.md", import.meta.url),
  ]);

  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ["scout", "merge_conflicts", "right_hand"],
  );
  const scout = definitions.find((definition) => definition.name === "scout")!;
  assert.match(scout.description, /factual lookup, not analysis/);
  assert.match(scout.systemPrompt, /leave the reasoning to the parent agent/);

  const mergeConflicts = definitions.find((definition) => definition.name === "merge_conflicts")!;
  assert.equal(mergeConflicts.maxTurns, undefined);
  const gitAdd = mergeConflicts.commandPolicy.find((entry) => entry.name === "git add")!;
  assert.ok("allowedFlags" in gitAdd);
  assert.deepEqual(gitAdd.allowedFlags, []);

  const rightHand = definitions.find((definition) => definition.name === "right_hand")!;
  assert.equal(rightHand.model, "openai-codex/gpt-5.6-luna");
  assert.equal(rightHand.thinking, "high");
  assert.equal(rightHand.inheritTools, true);
  assert.equal(rightHand.inheritSubagents, true);
  assert.equal(rightHand.inheritCommandPolicy, true);
  assert.deepEqual(rightHand.tools, []);
  assert.deepEqual(rightHand.subagents, []);
});

test("parses frontmatter as metadata and the body as the system prompt", () => {
  assert.deepEqual(parseSubagentDefinition(validDefinition, "scout.md"), {
    name: "scout",
    label: "Scout",
    description: "Scout a codebase",
    model: "openai-codex/gpt-5.6-luna",
    thinking: "low",
    prompt: "parent",
    tools: ["read", "grep", "find", "ls"],
    inheritTools: false,
    subagents: [],
    inheritSubagents: false,
    commandPolicy: [],
    inheritCommandPolicy: false,
    maxTurns: 15,
    systemPrompt: "You are a read-only codebase scout.",
    filePath: "scout.md",
  });
});

test("defaults bash agents to an empty deny-by-default command policy", () => {
  const definition = validDefinition.replace("tools: read, grep, find, ls", "tools: read, bash");
  const parsed = parseSubagentDefinition(definition, "shell.md");

  assert.deepEqual(parsed.tools, ["read", "bash"]);
  assert.deepEqual(parsed.commandPolicy, []);
});

test("parses nested sub-agent names", () => {
  const definition = validDefinition.replace("subagents: []", "subagents: [scout, reviewer]");

  assert.deepEqual(parseSubagentDefinition(definition, "worker.md").subagents, [
    "scout",
    "reviewer",
  ]);
});

test("rejects missing nested agents and cycles", () => {
  const agent = (name: string, subagents: string[]) =>
    parseSubagentDefinition(
      validDefinition
        .replace("name: scout", `name: ${name}`)
        .replace("subagents: []", `subagents: [${subagents.join(", ")}]`),
      `${name}.md`,
    );

  assert.throws(
    () => validateSubagentDefinitions([agent("worker", ["missing"])]),
    /unknown nested sub-agent 'missing'/,
  );
  assert.throws(
    () =>
      validateSubagentDefinitions([agent("worker", ["reviewer"]), agent("reviewer", ["worker"])]),
    /nested sub-agent cycle: worker -> reviewer -> worker/,
  );
});

test("parses inherited tools, sub-agents, and command policy", () => {
  const definition = validDefinition
    .replace("tools: read, grep, find, ls", "tools: inherit")
    .replace("subagents: []", "subagents: inherit")
    .replace("maxTurns: 15", "command_policy: inherit\nmaxTurns: 15");

  const parsed = parseSubagentDefinition(definition, "worker.md");
  assert.equal(parsed.inheritTools, true);
  assert.equal(parsed.inheritSubagents, true);
  assert.equal(parsed.inheritCommandPolicy, true);
  assert.deepEqual(parsed.tools, []);
  assert.deepEqual(parsed.subagents, []);
  assert.deepEqual(parsed.commandPolicy, []);
});

test("parses an agent-specific command policy", () => {
  const definition = validDefinition.replace(
    "maxTurns: 15",
    `command_policy:
  - name: git status
    status: allowed
    command: git
    subcommand:
      - [status]
    allowedFlags: [--short, --porcelain]
  - name: sudo
    status: banned
    command: sudo
    description: Privilege escalation is forbidden
maxTurns: 15`,
  );

  assert.deepEqual(parseSubagentDefinition(definition, "shell.md").commandPolicy, [
    {
      name: "git status",
      status: "allowed",
      command: "git",
      subcommand: [["status"]],
      allowedFlags: ["--short", "--porcelain"],
    },
    {
      name: "sudo",
      status: "banned",
      command: "sudo",
      description: "Privilege escalation is forbidden",
    },
  ]);
});

test("allows coding and caller-provided tool names", () => {
  const definition = validDefinition.replace(
    "tools: read, grep, find, ls",
    "tools: read, write, edit, domain_lookup",
  );

  assert.deepEqual(parseSubagentDefinition(definition, "worker.md").tools, [
    "read",
    "write",
    "edit",
    "domain_lookup",
  ]);
});

test("rejects malformed tool names", () => {
  const definition = validDefinition.replace(
    "tools: read, grep, find, ls",
    "tools: read, ../unsafe",
  );

  assert.throws(
    () => parseSubagentDefinition(definition, "unsafe.md"),
    /tool '\.\.\/unsafe' is not a valid tool name/,
  );
});

test("rejects unknown metadata fields", () => {
  const definition = validDefinition.replace("thinking: low", "thinkng: low");

  assert.throws(
    () => parseSubagentDefinition(definition, "typo.md"),
    /unknown frontmatter field 'thinkng'/,
  );
});

test("rejects an empty system prompt", () => {
  const definition = validDefinition.replace("You are a read-only codebase scout.", "");

  assert.throws(
    () => parseSubagentDefinition(definition, "empty.md"),
    /body must contain the system prompt/,
  );
});
