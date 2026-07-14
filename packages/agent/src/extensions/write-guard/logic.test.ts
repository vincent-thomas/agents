/**
 * logic.test.ts — tests for write-guard helpers.
 */

import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { checkFileTooLarge, MAX_LINES } from "./logic.ts";

suite("write-guard — checkFileTooLarge", () => {
	test("small file under threshold returns null", () => {
		assert.equal(checkFileTooLarge("test.txt", "line1\nline2\n", 5), null);
	});

	test("file exactly at threshold returns null", () => {
		const content = Array(10).fill("line").join("\n");
		assert.equal(checkFileTooLarge("test.txt", content, 10), null);
	});

	test("file over threshold returns block reason", () => {
		const content = Array(51).fill("line").join("\n");
		const reason = checkFileTooLarge("big.txt", content);
		assert.ok(reason !== null);
		assert.ok(reason!.includes("big.txt"));
		assert.ok(reason!.includes("51 lines"));
		assert.ok(reason!.includes("50"));
	});

	test("empty file returns null", () => {
		assert.equal(checkFileTooLarge("empty.txt", "", MAX_LINES), null);
	});

	test("single line file returns null", () => {
		assert.equal(checkFileTooLarge("one.txt", "hello", MAX_LINES), null);
	});

	test("uses default MAX_LINES when no threshold provided", () => {
		const content = Array(MAX_LINES + 1).fill("line").join("\n");
		const reason = checkFileTooLarge("large.txt", content);
		assert.ok(reason !== null);
		assert.ok(reason!.includes(`${MAX_LINES + 1} lines`));
	});
});

suite("write-guard — MAX_LINES constant", () => {
	test("MAX_LINES is a positive number", () => {
		assert.ok(MAX_LINES > 0);
		assert.equal(typeof MAX_LINES, "number");
	});
});
