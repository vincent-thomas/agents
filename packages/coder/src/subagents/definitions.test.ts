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
available_to:
  root: true
  subagents: []
maxTurns: 15
---

You are a read-only codebase scout.
`;

test("loads definitions from an explicit list of Markdown paths", () => {
  const definitions = loadSubagentDefinitions([
    new URL("../../agents/scout.md", import.meta.url),
    new URL("../../agents/merge-conflicts.md", import.meta.url),
    new URL("../../agents/review.md", import.meta.url),
    new URL("../../agents/right-hand.md", import.meta.url),
  ]);

  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ["scout", "merge_conflicts", "review", "right_hand"],
  );
  const scout = definitions.find((definition) => definition.name === "scout")!;
  assert.match(scout.description, /factual lookup, not analysis/);
  assert.match(scout.systemPrompt, /leave the reasoning to the parent agent/);
  assert.deepEqual(scout.availableToSubagents, ["merge_conflicts", "review", "right_hand"]);

  const mergeConflicts = definitions.find((definition) => definition.name === "merge_conflicts")!;
  assert.equal(mergeConflicts.maxTurns, undefined);
  const gitAdd = mergeConflicts.commandPolicy.find((entry) => entry.name === "git add")!;
  assert.ok("allowedFlags" in gitAdd);
  assert.deepEqual(gitAdd.allowedFlags, []);
  assert.match(
    mergeConflicts.systemPrompt,
    /compact final response under exactly these headings: `Resolved`,\s+`Verification`, and `Blockers`/,
  );
  assert.match(mergeConflicts.systemPrompt, /semantic choice made for each conflict/);

  const review = definitions.find((definition) => definition.name === "review")!;
  assert.equal(review.thinking, "high");
  assert.match(review.description, /correctness, regressions, and missing tests/);
  assert.deepEqual(review.tools, ["read", "grep", "find", "ls", "bash"]);
  assert.match(
    review.systemPrompt,
    /compact final response under exactly these headings:\s+`Findings` and\s+`Residual risk`/,
  );
  assert.match(review.systemPrompt, /severity, path and line/);
  assert.match(review.systemPrompt, /concise actionable direction/);

  const rightHand = definitions.find((definition) => definition.name === "right_hand")!;
  assert.equal(rightHand.model, "openai-codex/gpt-5.6-luna");
  assert.equal(rightHand.thinking, "high");
  assert.match(rightHand.description, /coherent bounded implementation outcomes/);
  assert.match(
    rightHand.description,
    /scoped implementation analysis and local reversible decisions/,
  );
  assert.match(rightHand.description, /all global decisions, irreversible or high-risk decisions/);
  assert.doesNotMatch(rightHand.description, /general-purpose/i);
  assert.match(rightHand.description, /cannot commit or push/);
  assert.match(
    rightHand.systemPrompt,
    /role is execution plus scoped\s+implementation analysis, not advisory-only work/,
  );
  assert.match(rightHand.systemPrompt, /concrete workspace-changing\s+outcome/);
  assert.match(
    rightHand.systemPrompt,
    /parent agent owns all global decisions, any irreversible or high-risk\s+decision/,
  );
  assert.match(
    rightHand.systemPrompt,
    /you own implementation\s+analysis and ordinary local, reversible decisions/,
  );
  assert.match(
    rightHand.systemPrompt,
    /Resolve ordinary local\s+ambiguity from repository evidence; do not bounce it to the parent/,
  );
  assert.match(rightHand.systemPrompt, /Use `scout` for broad codebase discovery/);
  assert.match(rightHand.systemPrompt, /routine narrow work, inspect the relevant files directly/);
  assert.match(rightHand.systemPrompt, /without duplicating discovery already delegated/);
  assert.match(
    rightHand.systemPrompt,
    /If asked only to inspect, propose, recommend, or otherwise advise without\s+making workspace changes/,
  );
  assert.match(
    rightHand.systemPrompt,
    /concise blocker asking the parent to decide\s+and delegate an implementation task/,
  );
  assert.match(
    rightHand.systemPrompt,
    /compact final response under exactly these headings: `Behavior`,\s+`Files`, `Validation`, and `Blockers`/,
  );
  assert.match(rightHand.systemPrompt, /Do not narrate the process or include\s+raw Scout output/);
  assert.equal(rightHand.inheritTools, false);
  assert.equal(rightHand.availableToRoot, true);
  assert.deepEqual(rightHand.availableToSubagents, []);
  assert.equal(rightHand.inheritCommandPolicy, true);
  assert.deepEqual(rightHand.tools, ["read", "write", "bash", "edit"]);
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
    availableToRoot: true,
    availableToSubagents: [],
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

test("parses target-owned availability and defaults root access", () => {
  const definition = validDefinition.replace(
    "  root: true\n  subagents: []",
    "  subagents: [scout, reviewer]",
  );
  const parsed = parseSubagentDefinition(definition, "worker.md");

  assert.equal(parsed.availableToRoot, true);
  assert.deepEqual(parsed.availableToSubagents, ["scout", "reviewer"]);
});

test("rejects unknown available agents and availability cycles", () => {
  const agent = (name: string, availableToSubagents: string[]) =>
    parseSubagentDefinition(
      validDefinition
        .replace("name: scout", `name: ${name}`)
        .replace("  subagents: []", `  subagents: [${availableToSubagents.join(", ")}]`),
      `${name}.md`,
    );

  assert.throws(
    () => validateSubagentDefinitions([agent("worker", ["missing"])]),
    /unknown available sub-agent 'missing'/,
  );
  assert.throws(
    () =>
      validateSubagentDefinitions([agent("worker", ["reviewer"]), agent("reviewer", ["worker"])]),
    /sub-agent availability cycle: worker -> reviewer -> worker/,
  );
});

test("parses inherited tools and command policy", () => {
  const definition = validDefinition
    .replace("tools: read, grep, find, ls", "tools: inherit")
    .replace("maxTurns: 15", "command_policy: inherit\nmaxTurns: 15");

  const parsed = parseSubagentDefinition(definition, "worker.md");
  assert.equal(parsed.inheritTools, true);
  assert.equal(parsed.inheritCommandPolicy, true);
  assert.deepEqual(parsed.tools, []);
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
