import assert from "node:assert/strict";
import { suite, test } from "node:test";
import {
  contentText,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import { RLM } from "./rlm.ts";

function javascript(code: string) {
  return fauxAssistantMessage(fauxToolCall("javascript", { code }), { stopReason: "toolUse" });
}

function visibleText(context: Context): string {
  return context.messages
    .map((message) => ("content" in message ? contentText(message.content as any) : ""))
    .join("\n");
}

suite("RLM", () => {
  test("does not prompt-stuff root external context", async () => {
    const hugeContext = `SECRET_SENTINEL_${"x".repeat(100_000)}`;
    const seen: Context[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("answer");
      },
    ]);

    const result = await new RLM(
      { model: faux.getModel(), context: hugeContext },
      { streamFn: faux.streamSimple },
    ).run("inspect it");

    assert.equal(result, "answer");
    assert.equal(seen.length, 1);
    assert.doesNotMatch(seen[0].systemPrompt ?? "", /SECRET_SENTINEL/);
    assert.doesNotMatch(visibleText(seen[0]), /SECRET_SENTINEL/);
    assert.match(visibleText(seen[0]), /inspect it/);
    assert.equal(seen[0].tools?.map((tool) => tool.name).join(","), "javascript");
  });

  test("lets JavaScript inspect context and preserve state across tool turns", async () => {
    const toolObservations: string[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript("const matches = [...context.matchAll(/NEEDLE/g)]; console.log(matches.length)"),
      (context) => {
        toolObservations.push(visibleText(context));
        return javascript("console.log(matches[0][0])");
      },
      (context) => {
        toolObservations.push(visibleText(context));
        return fauxAssistantMessage("found two");
      },
    ]);

    const answer = await new RLM(
      { model: faux.getModel(), context: "NEEDLE gap NEEDLE" },
      { streamFn: faux.streamSimple },
    ).run("count needles");

    assert.equal(answer, "found two");
    assert.match(toolObservations[0], /2/);
    assert.match(toolObservations[1], /NEEDLE/);
  });

  test("recursively delegates only the selected child context", async () => {
    const seen: Context[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      (context) => {
        seen.push(context);
        return javascript('console.log(await llm("analyze delegated text", context.slice(2, 7)))');
      },
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("child finding");
      },
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("root synthesis");
      },
    ]);

    const answer = await new RLM(
      { model: faux.getModel(), context: "0123456789", maxDepth: 1 },
      { streamFn: faux.streamSimple },
    ).run("root task");

    assert.equal(answer, "root synthesis");
    assert.doesNotMatch(visibleText(seen[0]), /0123456789/);
    assert.match(visibleText(seen[1]), /23456/);
    assert.doesNotMatch(visibleText(seen[1]), /0123456789/);
    assert.equal(seen[1].tools?.length ?? 0, 0);
    assert.match(visibleText(seen[2]), /child finding/);
  });

  test("removes recursive JavaScript at maxDepth", async () => {
    const seen: Context[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      (context) => {
        seen.push(context);
        return javascript('console.log(await llm("recurse"))');
      },
      (context) => {
        seen.push(context);
        return javascript('console.log(await llm("recurse"))');
      },
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("leaf");
      },
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("middle");
      },
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("root");
      },
    ]);

    const answer = await new RLM(
      { model: faux.getModel(), context: "delegated", maxDepth: 2 },
      { streamFn: faux.streamSimple },
    ).run("start");

    assert.equal(answer, "root");
    assert.equal(seen.length, 5);
    assert.equal(seen[0].tools?.[0]?.name, "javascript");
    assert.equal(seen[1].tools?.[0]?.name, "javascript");
    assert.equal(seen[2].tools?.length ?? 0, 0);
    assert.match(visibleText(seen[2]), /delegated/);
  });

  test("enforces the shared model-call limit", async () => {
    const faux = createFauxCore({});
    faux.setResponses([javascript('console.log("used the only call")')]);
    const rlm = new RLM(
      { model: faux.getModel(), context: "", maxModelCalls: 1 },
      { streamFn: faux.streamSimple },
    );
    await assert.rejects(rlm.run("task"), /model-call limit before synthesis/);
    assert.equal(faux.state.callCount, 1);
  });

  test("isolates separate top-level run invocations", async () => {
    const observations: string[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript("const topLevelSecret = 42"),
      fauxAssistantMessage("first"),
      javascript("console.log(typeof topLevelSecret)"),
      (context) => {
        observations.push(visibleText(context));
        return fauxAssistantMessage("second");
      },
    ]);
    const rlm = new RLM({ model: faux.getModel(), context: "" }, { streamFn: faux.streamSimple });

    assert.equal(await rlm.run("first run"), "first");
    assert.equal(await rlm.run("second run"), "second");
    assert.match(observations[0], /undefined/);
  });

  test("returns JavaScript errors to the model and keeps the runtime alive", async () => {
    const observations: string[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript('throw new Error("boom")'),
      (context) => {
        observations.push(visibleText(context));
        return javascript('console.log("still alive")');
      },
      (context) => {
        observations.push(visibleText(context));
        return fauxAssistantMessage("recovered");
      },
    ]);

    const answer = await new RLM(
      { model: faux.getModel(), context: "" },
      { streamFn: faux.streamSimple },
    ).run("recover from an error");

    assert.equal(answer, "recovered");
    assert.match(observations[0], /boom/);
    assert.match(observations[1], /still alive/);
  });
});
