import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubagentCatalog, resolveInheritedDefinition } from "./catalog.ts";

test("requires code-owned functions for generated prompt sources", () => {
  assert.throws(
    () =>
      createSubagentCatalog({
        paths: [
          new URL("../../agents/scout.md", import.meta.url),
          new URL("../../agents/merge-conflicts.md", import.meta.url),
          new URL("../../agents/right-hand.md", import.meta.url),
        ],
        getModelFn: () => ({}) as never,
        inheritedCommandPolicy: [],
      }),
    /Unknown prompt source 'merge_conflicts'/,
  );
});

test("requires the host policy for inherited command policies", () => {
  assert.throws(
    () =>
      createSubagentCatalog({
        paths: [
          new URL("../../agents/scout.md", import.meta.url),
          new URL("../../agents/merge-conflicts.md", import.meta.url),
          new URL("../../agents/right-hand.md", import.meta.url),
        ],
        getModelFn: () => ({}) as never,
        promptFns: { merge_conflicts: () => "resolve conflicts" },
      }),
    /No inherited command policy supplied/,
  );
});

test("accepts an inherited command policy supplied by the host", () => {
  const mainPolicy = [{ name: "make", status: "allowed" as const, command: "make" }];
  const catalog = createSubagentCatalog({
    paths: [
      new URL("../../agents/scout.md", import.meta.url),
      new URL("../../agents/merge-conflicts.md", import.meta.url),
      new URL("../../agents/right-hand.md", import.meta.url),
    ],
    getModelFn: () => ({}) as never,
    promptFns: { merge_conflicts: () => "resolve conflicts" },
    inheritedCommandPolicy: mainPolicy,
  });

  const rightHand = catalog.definitions.find((definition) => definition.name === "right_hand")!;
  const resolved = resolveInheritedDefinition({
    definition: { ...rightHand, tools: [], inheritTools: true },
    parentToolNames: ["read", "bash", "git_commit", "agent"],
    inheritedCommandPolicy: mainPolicy,
  });

  assert.deepEqual(resolved.tools, ["read", "bash", "git_commit"]);
  assert.equal(resolved.commandPolicy, mainPolicy);
});

test("resolves frontmatter models through the supplied provider lookup", () => {
  const requests: Array<[string, string]> = [];

  const catalog = createSubagentCatalog({
    paths: [
      new URL("../../agents/scout.md", import.meta.url),
      new URL("../../agents/merge-conflicts.md", import.meta.url),
      new URL("../../agents/right-hand.md", import.meta.url),
    ],
    getModelFn(provider, model) {
      requests.push([provider, model]);
      return {} as never;
    },
    promptFns: { merge_conflicts: () => "resolve conflicts" },
    inheritedCommandPolicy: [],
  });

  assert.deepEqual(requests, [
    ["openai-codex", "gpt-5.6-luna"],
    ["openai-codex", "gpt-5.6-luna"],
    ["openai-codex", "gpt-5.6-luna"],
  ]);
  assert.deepEqual(
    catalog.definitions.map((definition) => definition.name),
    ["scout", "merge_conflicts", "right_hand"],
  );
});
