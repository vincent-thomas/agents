import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_EXPLORE_TURNS, buildExplorePrompt, formatExploreResult, hasExceededTurnLimit } from "./logic.ts";

test("buildExplorePrompt embeds the query and states the read-only constraint", () => {
	const prompt = buildExplorePrompt("where is the retry logic for CI polling?");
	assert.match(prompt, /where is the retry logic for CI polling\?/);
	assert.match(prompt, /read-only/i);
	assert.match(prompt, /cannot write, edit, or run/i);
});

test("formatExploreResult returns the text unchanged when present", () => {
	assert.equal(formatExploreResult("Found it in foo.ts:12"), "Found it in foo.ts:12");
});

test("formatExploreResult falls back when the sub-agent returned nothing", () => {
	assert.equal(
		formatExploreResult(undefined),
		"The exploration sub-agent did not return an answer.",
	);
	assert.equal(
		formatExploreResult("   "),
		"The exploration sub-agent did not return an answer.",
	);
});

test("hasExceededTurnLimit trips at the configured cap", () => {
	assert.equal(hasExceededTurnLimit(MAX_EXPLORE_TURNS - 1), false);
	assert.equal(hasExceededTurnLimit(MAX_EXPLORE_TURNS), true);
});
