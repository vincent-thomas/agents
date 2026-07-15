/**
 * logic.test.ts — tests for write-guard helpers.
 */

import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { checkFileTooLarge } from "./logic.ts";

const TEST_THRESHOLD = 50;

suite("write-guard — checkFileTooLarge", () => {
  test("small file under threshold returns null", () => {
    assert.equal(checkFileTooLarge("test.txt", "line1\nline2\n", 5), null);
  });

  test("file exactly at threshold returns null", () => {
    const content = Array(10).fill("line").join("\n");
    assert.equal(checkFileTooLarge("test.txt", content, 10), null);
  });

  test("file over threshold returns block reason", () => {
    const content = Array(TEST_THRESHOLD + 1)
      .fill("line")
      .join("\n");
    const reason = checkFileTooLarge("big.txt", content, TEST_THRESHOLD);
    assert.ok(reason !== null);
    assert.ok(reason!.includes("big.txt"));
    assert.ok(reason!.includes(`${TEST_THRESHOLD + 1} lines`));
    assert.ok(reason!.includes(`${TEST_THRESHOLD}`));
  });

  test("empty file returns null", () => {
    assert.equal(checkFileTooLarge("empty.txt", "", TEST_THRESHOLD), null);
  });

  test("single line file returns null", () => {
    assert.equal(checkFileTooLarge("one.txt", "hello", TEST_THRESHOLD), null);
  });

  test("uses the supplied threshold", () => {
    const threshold = 3;
    const content = Array(threshold + 1)
      .fill("line")
      .join("\n");
    const reason = checkFileTooLarge("large.txt", content, threshold);
    assert.ok(reason !== null);
    assert.ok(reason!.includes(`${threshold + 1} lines`));
  });
});
