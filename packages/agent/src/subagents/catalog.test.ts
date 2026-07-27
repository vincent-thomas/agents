import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubagentCatalog } from "./catalog.ts";

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
  assert.deepEqual(catalog.definitions.map((definition) => definition.name), [
    "scout",
  ]);
});
