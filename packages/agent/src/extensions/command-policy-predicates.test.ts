/**
 * predicates.test.ts — tests for this extension's language interpreter
 * command predicates (used to build the extension's `entries` array).
 *
 * Run with:   node --test predicates.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAwkCommand, isPerlCommand, isPythonCommand } from "./command-policy-predicates.ts";

const predicateMatches = [
  ["python", isPythonCommand],
  ["python2", isPythonCommand],
  ["python3.12", isPythonCommand],
  ["perl", isPerlCommand],
  ["perl5.38", isPerlCommand],
  ["gawk", isAwkCommand],
  ["mawk", isAwkCommand],
  ["nawk", isAwkCommand],
  ["awk", isAwkCommand],
] as const;

for (const [name, predicate] of predicateMatches) {
  test(`matches: ${name}`, () => {
    assert.ok(predicate(name));
  });
}

const predicateNonMatches = [
  ["pythonize", isPythonCommand],
  ["ipython", isPythonCommand],
  ["perlbrew", isPerlCommand],
  ["awkward", isAwkCommand],
] as const;

for (const [name, predicate] of predicateNonMatches) {
  test(`does not match: ${name}`, () => {
    assert.ok(!predicate(name));
  });
}
