import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubagentCatalog } from "./catalog.ts";

test("requires code-owned functions for generated prompt sources", () => {
  assert.throws(
    () =>
      createSubagentCatalog({
        paths: [
          new URL("../../agents/scout.md", import.meta.url),
          new URL("../../agents/merge-conflicts.md", import.meta.url),
        ],
        getModelFn: () => ({}) as never,
      }),
    /Unknown prompt source 'merge_conflicts'/,
  );
});

test("requires code-owned named command policies", () => {
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
    /Unknown command policy 'main'/,
  );
});

test("resolves named command policies supplied by the host", () => {
  const mainPolicy = [{ name: "make", status: "allowed" as const, command: "make" }];
  const catalog = createSubagentCatalog({
    paths: [
      new URL("../../agents/scout.md", import.meta.url),
      new URL("../../agents/merge-conflicts.md", import.meta.url),
      new URL("../../agents/right-hand.md", import.meta.url),
    ],
    getModelFn: () => ({}) as never,
    promptFns: { merge_conflicts: () => "resolve conflicts" },
    commandPolicies: { main: mainPolicy },
  });

  assert.equal(
    catalog.definitions.find((definition) => definition.name === "right_hand")!.commandPolicy,
    mainPolicy,
  );
});

test("resolves frontmatter models through the supplied provider lookup", () => {
  const requests: Array<[string, string]> = [];

  const catalog = createSubagentCatalog({
    paths: [new URL("../../agents/scout.md", import.meta.url)],
    getModelFn(provider, model) {
      requests.push([provider, model]);
      return {} as never;
    },
  });

  assert.deepEqual(requests, [["openai-codex", "gpt-5.6-luna"]]);
  assert.deepEqual(
    catalog.definitions.map((definition) => definition.name),
    ["scout"],
  );
});
