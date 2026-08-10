import assert from "node:assert/strict";
import { suite, test } from "node:test";
import {
  contentText,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import { RLM, type RLMEvent } from "./rlm.ts";

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
    assert.match(seen[0].systemPrompt ?? "", /ctx\.context.*external context string/);
    assert.match(seen[0].systemPrompt ?? "", /Bare .*console.* globals are unavailable/);
    assert.match(seen[0].systemPrompt ?? "", /empty .*ctx\.context.* is valid/);
    assert.match(seen[0].systemPrompt ?? "", /correctness can be specified mechanically/);
    assert.match(seen[0].systemPrompt ?? "", /interpretation, judgment, or reasoning/);
    assert.match(seen[0].systemPrompt ?? "", /partition it, delegate the required judgment/);
    assert.match(seen[0].systemPrompt ?? "", /unvalidated shortcut or proxy/);
    assert.doesNotMatch(visibleText(seen[0]), /SECRET_SENTINEL/);
    assert.match(visibleText(seen[0]), /inspect it/);
    assert.equal(seen[0].tools?.map((tool) => tool.name).join(","), "javascript");
  });

  test("defaults to high thinking and resolves recursive credentials", async () => {
    const seenApiKeys: Array<string | undefined> = [];
    const seenReasoning: Array<string | undefined> = [];
    const faux = createFauxCore({});
    faux.setResponses([
      (_context, options) => {
        seenApiKeys.push(options?.apiKey);
        seenReasoning.push(options?.reasoning);
        return javascript('ctx.console.log(await ctx.llm("delegate"))');
      },
      (_context, options) => {
        seenApiKeys.push(options?.apiKey);
        seenReasoning.push(options?.reasoning);
        return fauxAssistantMessage("child");
      },
      (_context, options) => {
        seenApiKeys.push(options?.apiKey);
        seenReasoning.push(options?.reasoning);
        return fauxAssistantMessage("root");
      },
    ]);
    const resolvedProviders: string[] = [];

    const answer = await new RLM(
      {
        model: faux.getModel(),
        context: "delegated context",
        maxDepth: 1,
        getApiKey: (provider) => {
          resolvedProviders.push(provider);
          return "saved-pi-token";
        },
      },
      { streamFn: faux.streamSimple },
    ).run("root task");

    assert.equal(answer, "root");
    assert.deepEqual(seenApiKeys, ["saved-pi-token", "saved-pi-token", "saved-pi-token"]);
    assert.deepEqual(seenReasoning, ["high", "high", "high"]);
    assert.deepEqual(resolvedProviders, [faux.provider, faux.provider, faux.provider]);
  });

  test("emits depth-aware events for tools and recursive runs", async () => {
    const events: RLMEvent[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript('ctx.console.log(await ctx.llm("child task", ctx.context.slice(0, 5)))'),
      fauxAssistantMessage("child answer"),
      fauxAssistantMessage("root answer"),
    ]);

    const result = await new RLM(
      {
        model: faux.getModel(),
        context: "child context",
        maxDepth: 1,
        onEvent: (event) => {
          events.push(event);
        },
      },
      { streamFn: faux.streamSimple },
    ).runDetailed("root task");

    assert.equal(result.text, "root answer");
    assert.equal(result.usage.modelCalls, 3);
    assert.ok(result.usage.totalTokens > 0);
    assert.deepEqual(
      events.filter((event) => event.type === "run_start").map((event) => event.depth),
      [0, 1],
    );
    const [rootStart, childStart] = events.filter((event) => event.type === "run_start");
    assert.equal(rootStart.runId, 0);
    assert.equal(rootStart.parentRunId, undefined);
    assert.equal(childStart.runId, 1);
    assert.equal(childStart.parentRunId, 0);
    assert.equal(events.filter((event) => event.type === "model_start").length, 3);
    assert.equal(events.filter((event) => event.type === "model_end").length, 3);
    const toolStart = events.find((event) => event.type === "javascript_start");
    assert.equal(toolStart?.depth, 0);
    assert.match(toolStart?.type === "javascript_start" ? toolStart.code : "", /llm\("child task"/);
    const toolEnd = events.find((event) => event.type === "javascript_end");
    assert.equal(toolEnd?.depth, 0);
    assert.match(toolEnd?.type === "javascript_end" ? toolEnd.output : "", /child answer/);
    assert.deepEqual(
      events.filter((event) => event.type === "run_end").map((event) => event.depth),
      [1, 0],
    );
    const rootEnd = events.findLast((event) => event.type === "run_end" && event.depth === 0);
    assert.deepEqual(rootEnd?.type === "run_end" ? rootEnd.usage : undefined, result.usage);
  });

  test("cancels a run and emits a stable error event", async () => {
    const controller = new AbortController();
    const events: RLMEvent[] = [];
    const faux = createFauxCore({ tokensPerSecond: 1 });
    faux.setResponses([fauxAssistantMessage("response that should be aborted")]);
    const rlm = new RLM(
      {
        model: faux.getModel(),
        context: "",
        onEvent: (event) => {
          events.push(event);
          if (event.type === "model_start") controller.abort();
        },
      },
      { streamFn: faux.streamSimple },
    );

    await assert.rejects(rlm.run("cancel me", { signal: controller.signal }), {
      name: "AbortError",
    });
    const failure = events.find((event) => event.type === "run_error");
    assert.equal(failure?.type === "run_error" ? failure.error : "", "RLM run aborted");
    assert.equal(failure?.type === "run_error" ? failure.usage.modelCalls : 0, 1);
  });

  test("lets JavaScript inspect context and preserve state across tool turns", async () => {
    const toolObservations: string[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript(
        "const matches = [...ctx.context.matchAll(/NEEDLE/g)]; ctx.console.log(matches.length)",
      ),
      (context) => {
        toolObservations.push(visibleText(context));
        return javascript("ctx.console.log(matches[0][0])");
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
        return javascript(
          'ctx.console.log(await ctx.llm("analyze delegated text", ctx.context.slice(2, 7)))',
        );
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
        return javascript('ctx.console.log(await ctx.llm("recurse"))');
      },
      (context) => {
        seen.push(context);
        return javascript('ctx.console.log(await ctx.llm("recurse"))');
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
    faux.setResponses([javascript('ctx.console.log("used the only call")')]);
    const rlm = new RLM(
      { model: faux.getModel(), context: "", maxModelCalls: 1 },
      { streamFn: faux.streamSimple },
    );
    await assert.rejects(rlm.run("task"), /model-call limit before synthesis/);
    assert.equal(faux.state.callCount, 1);
  });

  test("preserves the primary budget error for concurrent recursive delegates", async () => {
    const errors: string[] = [];
    const toolErrors: string[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript(
        'await Promise.all([ctx.llm("child one"), ctx.llm("child two"), ctx.llm("child three")])',
      ),
      javascript('await ctx.llm("grandchild")'),
      javascript('await ctx.llm("grandchild")'),
      javascript('await ctx.llm("grandchild")'),
      fauxAssistantMessage("leaf one"),
      fauxAssistantMessage("leaf two"),
      fauxAssistantMessage("leaf three"),
    ]);
    const rlm = new RLM(
      {
        model: faux.getModel(),
        context: "delegated",
        maxDepth: 2,
        maxModelCalls: 7,
        onEvent: (event) => {
          if (event.type === "run_error") errors.push(event.error);
          if (event.type === "javascript_end" && event.isError) {
            toolErrors.push(event.output);
          }
        },
      },
      { streamFn: faux.streamSimple },
    );

    await assert.rejects(rlm.run("start"), /model-call limit/);
    assert.ok(errors.some((error) => /model-call limit/.test(error)));
    assert.ok(errors.every((error) => !/runtime is closed/i.test(error)));
    assert.ok(toolErrors.every((error) => !/runtime is closed/i.test(error)));
  });

  test("does not start a delayed recursive turn after sibling budget exhaustion", async () => {
    let releaseRunStart!: () => void;
    const runStartBarrier = new Promise<void>((resolve) => {
      releaseRunStart = resolve;
    });
    const faux = createFauxCore({});
    faux.setResponses([
      javascript('await Promise.all([ctx.llm("delayed"), ctx.llm("exhausts budget")])'),
    ]);
    const rlm = new RLM(
      {
        model: faux.getModel(),
        context: "",
        maxModelCalls: 2,
        onEvent: async (event) => {
          if (event.type === "run_start" && event.depth === 1) {
            await runStartBarrier;
          }
          if (event.type === "javascript_end" && event.depth === 0) {
            releaseRunStart();
          }
        },
      },
      { streamFn: faux.streamSimple },
    );

    await assert.rejects(rlm.run("start"), /model-call limit/);
    assert.equal(faux.state.callCount, 1);
  });

  test("isolates separate top-level run invocations", async () => {
    const observations: string[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript("const topLevelSecret = 42"),
      fauxAssistantMessage("first"),
      javascript("ctx.console.log(typeof topLevelSecret)"),
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

  test("terminates the run on a fatal JavaScript runtime rejection", async () => {
    const faux = createFauxCore({});
    faux.setResponses([
      javascript("while (true) {}"),
      fauxAssistantMessage("the model must not continue after the runtime closes"),
    ]);
    const rlm = new RLM(
      {
        model: faux.getModel(),
        context: "",
        executionTimeoutMs: 100,
      },
      { streamFn: faux.streamSimple },
    );

    await assert.rejects(rlm.run("stop on timeout"), /exceeded 100ms timeout/);
    assert.equal(faux.state.callCount, 1);
  });

  test("returns JavaScript errors to the model and keeps the runtime alive", async () => {
    const observations: string[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript('throw new Error("boom")'),
      (context) => {
        observations.push(visibleText(context));
        return javascript('ctx.console.log("still alive")');
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
