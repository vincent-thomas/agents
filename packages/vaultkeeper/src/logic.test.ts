import assert from "node:assert/strict";
import { test } from "node:test";
import { buildObsidianArgs, formatObsidianInvocation, formatObsidianOutput } from "./logic.ts";

test("buildObsidianArgs selects the configured vault by name", () => {
  assert.deepEqual(buildObsidianArgs("My Vault", "search", ["query=agency"]), [
    "vault=My Vault",
    "search",
    "query=agency",
  ]);
  assert.deepEqual(buildObsidianArgs("My Vault", "help", ["search"]), ["help", "search"]);
  assert.deepEqual(buildObsidianArgs("My Vault", "version", []), ["version"]);
});

test("formatObsidianInvocation preserves argv boundaries", () => {
  assert.equal(
    formatObsidianInvocation(["vault=My Vault", "search", "query=agent design"]),
    '$ obsidian "vault=My Vault" search "query=agent design"',
  );
});

test("buildObsidianArgs rejects invalid vault names", () => {
  assert.throws(() => buildObsidianArgs("", "read", []), /cannot be empty/);
  assert.throws(() => buildObsidianArgs("bad\0name", "read", []), /null bytes/);
});

test("buildObsidianArgs rejects attempts to select another vault", () => {
  for (const argument of ["vault=Other", "--vault=Other", "--vault", "Vault=Other"]) {
    assert.throws(() => buildObsidianArgs("My Vault", "read", [argument]), /cannot be overridden/);
  }
});

test("buildObsidianArgs rejects null bytes", () => {
  assert.throws(() => buildObsidianArgs("My Vault", "read", ["path=a\0b"]), /null bytes/);
});

test("formatObsidianOutput preserves output and diagnostics", () => {
  assert.equal(formatObsidianOutput("result\n", "warning\n"), "result\n\nCLI warnings:\nwarning");
  assert.equal(formatObsidianOutput("", ""), "The Obsidian CLI returned no output.");
});
