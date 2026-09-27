import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelPlanner, parsePlannerDecision } from "../src/model-planner.ts";
import { state, tempRepo } from "./helpers.ts";
import { ContextCompiler } from "../src/context-compiler.ts";

test("parses plain and fenced model decisions and rejects malformed actions", () => {
  assert.deepEqual(parsePlannerDecision('{"type":"blocked","reason":"done"}'), {
    type: "blocked",
    reason: "done",
  });
  assert.deepEqual(
    parsePlannerDecision('```json\n{"type":"finish","objectiveId":"root","evidenceIds":[]}\n```'),
    { type: "finish", objectiveId: "root", evidenceIds: [] },
  );
  assert.throws(
    () => parsePlannerDecision('{"type":"action","action":{"type":"command"}}'),
    /malformed/,
  );
});

test("builds a fresh canonical model turn and returns its validated decision", async () => {
  let systemPrompt = "";
  let input = "";
  const models = {
    async complete(
      _model: unknown,
      context: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> },
    ) {
      systemPrompt = context.systemPrompt ?? "";
      input = context.messages[0].content[0].text;
      return {
        role: "assistant",
        content: [{ type: "text", text: '{"type":"blocked","reason":"fixture"}' }],
        stopReason: "stop",
      };
    },
  };
  const run = await state(await tempRepo());
  const decision = await new ModelPlanner(models as never, {} as never).propose(
    new ContextCompiler().compile(run, "root"),
  );
  assert.deepEqual(decision, { type: "blocked", reason: "fixture" });
  assert.match(systemPrompt, /harness, not you, owns trusted state/i);
  assert.equal(JSON.parse(input).objective.id, "root");
});
