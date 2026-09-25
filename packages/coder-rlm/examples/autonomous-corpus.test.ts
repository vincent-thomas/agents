import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAutonomousEvaluationCorpus } from "./autonomous-corpus.ts";

test("autonomous evaluation corpus is heterogeneous and has known ground truth", () => {
  const corpus = buildAutonomousEvaluationCorpus();
  assert.equal(corpus.reportCount, 312);
  assert.ok(corpus.multiCauseReportCount >= 40);
  assert.ok(corpus.context.length > 250_000);
  assert.doesNotMatch(corpus.context, /The review found that/);
  assert.equal(corpus.expectedTopThemes.length, 3);
});
