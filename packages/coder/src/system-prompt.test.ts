import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const systemPrompt = readFileSync(new URL("../APPEND_SYSTEM.md", import.meta.url), "utf8");

test("delegates bounded outcomes without surrendering global decisions", () => {
  assert.match(systemPrompt, /Delegate coherent bounded outcomes early/);
  assert.match(
    systemPrompt,
    /delegate it to `right_hand` before doing detailed implementation discovery yourself/,
  );
  assert.match(systemPrompt, /Do not duplicate discovery already delegated/);
  assert.match(
    systemPrompt,
    /parent keeps ownership of all global decisions and any irreversible or high-risk decision/,
  );
  assert.match(
    systemPrompt,
    /`right_hand` owns scoped implementation analysis and ordinary local, reversible decisions/,
  );
});
