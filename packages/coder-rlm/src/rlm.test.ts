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
    assert.match(seen[0].systemPrompt ?? "", /least expensive reliable tier/);
    assert.match(seen[0].systemPrompt ?? "", /Large context alone is not a reason to use deep/);
    assert.match(seen[0].systemPrompt ?? "", /consequential advice, or final synthesis/);
    assert.doesNotMatch(seen[0].systemPrompt ?? "", /gpt-5\.6-luna|openai-codex/);
    assert.match(seen[0].systemPrompt ?? "", /unvalidated shortcut or proxy/);
    assert.doesNotMatch(visibleText(seen[0]), /SECRET_SENTINEL/);
    assert.match(visibleText(seen[0]), /inspect it/);
    assert.equal(seen[0].tools?.map((tool) => tool.name).join(","), "javascript");
  });

  test("defaults child recursion to balanced thinking and resolves recursive credentials", async () => {
    const seenApiKeys: Array<string | undefined> = [];
    const seenReasoning: Array<string | undefined> = [];
    const faux = createFauxCore({});
    faux.setResponses([
      (_context, options) => {
        seenApiKeys.push(options?.apiKey);
        seenReasoning.push(options?.reasoning);
        return javascript(
          'const h = await ctx.rlm.spawn("delegate"); ctx.console.log((await ctx.rlm.waitAll([h]))[0].text)',
        );
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
    assert.deepEqual(seenReasoning, ["high", "medium", "high"]);
    assert.deepEqual(resolvedProviders, [faux.provider, faux.provider, faux.provider]);
  });

  test("emits depth-aware events for tools and recursive runs", async () => {
    const events: RLMEvent[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript(
        'const h = await ctx.rlm.spawn("child task", { context: ctx.context.slice(0, 5) }); ctx.console.log((await ctx.rlm.waitAll([h]))[0].text)',
      ),
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
    assert.match(
      toolStart?.type === "javascript_start" ? toolStart.code : "",
      /rlm\.spawn\("child task"/,
    );
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
          'const h = await ctx.rlm.spawn("analyze delegated text", { context: ctx.context.slice(2, 7) }); ctx.console.log((await ctx.rlm.waitAll([h]))[0].text)',
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
        return javascript(
          'const h = await ctx.rlm.spawn("recurse"); ctx.console.log((await ctx.rlm.waitAll([h]))[0].text)',
        );
      },
      (context) => {
        seen.push(context);
        return javascript(
          'const h = await ctx.rlm.spawn("recurse"); ctx.console.log((await ctx.rlm.waitAll([h]))[0].text)',
        );
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
        'const hs = await Promise.all([ctx.rlm.spawn("child one"), ctx.rlm.spawn("child two"), ctx.rlm.spawn("child three")]); await ctx.rlm.waitAll(hs)',
      ),
      javascript('const h = await ctx.rlm.spawn("grandchild"); await ctx.rlm.waitAll([h])'),
      javascript('const h = await ctx.rlm.spawn("grandchild"); await ctx.rlm.waitAll([h])'),
      javascript('const h = await ctx.rlm.spawn("grandchild"); await ctx.rlm.waitAll([h])'),
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
    const runStartBarrier = new Promise<void>((resolve) => setTimeout(resolve, 20));
    const events: RLMEvent[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript(
        'const hs = await Promise.all([ctx.rlm.spawn("delayed"), ctx.rlm.spawn("exhausts budget")]); await ctx.rlm.waitAll(hs)',
      ),
    ]);
    const rlm = new RLM(
      {
        model: faux.getModel(),
        context: "",
        maxModelCalls: 2,
        onEvent: async (event) => {
          events.push(event);
          if (event.type === "run_start" && event.depth === 1) {
            await runStartBarrier;
          }
        },
      },
      { streamFn: faux.streamSimple },
    );

    await assert.rejects(rlm.run("start"), /model-call limit/);
    assert.equal(faux.state.callCount, 2);
    assert.ok(events.every((event) => event.type !== "model_end" || event.modelCall > 0));
  });

  test("serializes and flushes asynchronous event observers", async () => {
    const delivered: string[] = [];
    let observerActive = false;
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage("answer")]);

    const answer = await new RLM(
      {
        model: faux.getModel(),
        context: "",
        onEvent: async (event) => {
          assert.equal(observerActive, false);
          observerActive = true;
          await new Promise((resolve) => setTimeout(resolve, 2));
          delivered.push(event.type);
          observerActive = false;
        },
      },
      { streamFn: faux.streamSimple },
    ).run("observe");

    assert.equal(answer, "answer");
    assert.equal(observerActive, false);
    assert.equal(delivered[0], "run_start");
    assert.equal(delivered.at(-1), "run_end");
  });

  test("aborts and rejects when an event observer fails", async () => {
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage("answer")]);
    const rlm = new RLM(
      {
        model: faux.getModel(),
        context: "",
        onEvent: (event) => {
          if (event.type === "model_start") throw new Error("observer failed");
        },
      },
      { streamFn: faux.streamSimple },
    );

    await assert.rejects(rlm.run("observe failure"), /observer failed/);
  });

  test("enforces a separate model-request timeout", async () => {
    const events: RLMEvent[] = [];
    const faux = createFauxCore({ tokensPerSecond: 1 });
    faux.setResponses([fauxAssistantMessage("response that arrives too late")]);
    const rlm = new RLM(
      {
        model: faux.getModel(),
        context: "",
        modelRequestTimeoutMs: 20,
        runTimeoutMs: 1_000,
        onEvent: (event) => events.push(event),
      },
      { streamFn: faux.streamSimple },
    );

    await assert.rejects(rlm.run("slow model"), /model request exceeded 20ms timeout/);
    assert.equal(faux.state.callCount, 1);
    assert.ok(
      events.some(
        (event) =>
          event.type === "run_error" && /model request exceeded 20ms timeout/.test(event.error),
      ),
    );
  });

  test("enforces an overall run timeout without late events", async () => {
    const events: RLMEvent[] = [];
    const faux = createFauxCore({ tokensPerSecond: 1 });
    faux.setResponses([fauxAssistantMessage("response that arrives too late")]);
    const rlm = new RLM(
      {
        model: faux.getModel(),
        context: "",
        modelRequestTimeoutMs: 1_000,
        runTimeoutMs: 20,
        onEvent: (event) => events.push(event),
      },
      { streamFn: faux.streamSimple },
    );

    await assert.rejects(rlm.run("slow run"), /run exceeded 20ms overall timeout/);
    const settledEventCount = events.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(events.length, settledEventCount);
    assert.equal(events.at(-1)?.type, "run_error");
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
        javascriptStallTimeoutMs: 100,
      },
      { streamFn: faux.streamSimple },
    );

    await assert.rejects(rlm.run("stop on timeout"), /exceeded 100ms stall timeout/);
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

  test("applies tier profile model and thinking overrides while root stays configured", async () => {
    const faux = createFauxCore({});
    const rootModel = faux.getModel();
    const fastModel = {
      ...rootModel,
      id: "profile-fast-model",
      provider: "profile-provider",
    } as typeof rootModel;
    const seen: Array<{ model: string; reasoning: string | undefined }> = [];
    const resolvedProviders: string[] = [];
    faux.setResponses([
      javascript(
        'const h = await ctx.rlm.spawn("fast", { tier: "fast" }); await ctx.rlm.waitAll([h])',
      ),
      fauxAssistantMessage("fast"),
      fauxAssistantMessage("root"),
    ]);
    const answer = await new RLM(
      {
        model: rootModel,
        context: "",
        thinkingLevel: "high",
        tierProfiles: {
          fast: { model: fastModel, thinkingLevel: "low", modelRequestTimeoutMs: 123 },
        },
        getApiKey: (provider) => {
          resolvedProviders.push(provider);
          return "token";
        },
      },
      {
        streamFn: (model, context, options) => {
          seen.push({ model: model.id, reasoning: options?.reasoning });
          return faux.streamSimple(model, context, options);
        },
      },
    ).run("root");

    assert.equal(answer, "root");
    assert.deepEqual(
      seen.map(({ model }) => model),
      [rootModel.id, fastModel.id, rootModel.id],
    );
    assert.deepEqual(
      seen.map(({ reasoning }) => reasoning),
      ["high", "low", "high"],
    );
    assert.deepEqual(resolvedProviders, [
      rootModel.provider,
      "profile-provider",
      rootModel.provider,
    ]);
  });

  test("enforces a tier-specific model request timeout", async () => {
    const rootFaux = createFauxCore({});
    const childFaux = createFauxCore({ tokensPerSecond: 1 });
    const rootModel = rootFaux.getModel();
    const fastModel = { ...childFaux.getModel(), id: "slow-fast-model" };
    const events: RLMEvent[] = [];
    rootFaux.setResponses([
      javascript(
        'const h = await ctx.rlm.spawn("slow child", { tier: "fast" }); await ctx.rlm.waitAll([h])',
      ),
      fauxAssistantMessage("root recovered"),
    ]);
    childFaux.setResponses([fauxAssistantMessage("slow child response")]);

    const answer = await new RLM(
      {
        model: rootModel,
        context: "",
        tierProfiles: {
          fast: { model: fastModel, modelRequestTimeoutMs: 20 },
        },
        onEvent: (event) => events.push(event),
      },
      {
        streamFn: (model, context, options) =>
          model.id === fastModel.id
            ? childFaux.streamSimple(model, context, options)
            : rootFaux.streamSimple(model, context, options),
      },
    ).run("root");

    assert.equal(answer, "root recovered");
    assert.ok(
      events.some(
        (event) =>
          event.type === "child_error" &&
          event.result.tier === "fast" &&
          event.result.error?.message.includes("model request exceeded 20ms timeout"),
      ),
    );
  });

  test("selects independent nested tiers and serializes stable tier metadata", async () => {
    const events: RLMEvent[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript(
        'const h = await ctx.rlm.spawn("fast child", { tier: "fast" }); const r = (await ctx.rlm.waitAll([h]))[0]; ctx.console.log(JSON.stringify({ h, r }))',
      ),
      javascript(
        'const h = await ctx.rlm.spawn("deep child", { tier: "deep" }); await ctx.rlm.waitAll([h])',
      ),
      fauxAssistantMessage("deep result"),
      fauxAssistantMessage("fast result"),
      fauxAssistantMessage("root result"),
    ]);
    const result = await new RLM(
      { model: faux.getModel(), context: "", maxDepth: 2, onEvent: (event) => events.push(event) },
      { streamFn: faux.streamSimple },
    ).run("root");

    assert.equal(result, "root result");
    assert.deepEqual(
      events.filter((event) => event.type === "child_spawn").map((event) => event.tier),
      ["fast", "deep"],
    );
    const childEndTiers = events
      .filter((event) => event.type === "child_end")
      .map((event) => event.result.tier);
    assert.deepEqual(childEndTiers, ["deep", "fast"]);
    const fastHandle = events.find(
      (event) => event.type === "child_spawn" && event.tier === "fast",
    )?.handle;
    assert.ok(fastHandle);
    assert.deepEqual(JSON.parse(JSON.stringify(fastHandle)), fastHandle);
    assert.equal("model" in fastHandle, false);
  });

  test("enforces the deep-child admission cap", async () => {
    const events: RLMEvent[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript(
        'const hs = []; for (let i = 0; i < 5; i++) { try { hs.push(await ctx.rlm.spawn("deep", { tier: "deep" })); } catch (error) { ctx.console.log(error.message); } } await ctx.rlm.waitAll(hs)',
      ),
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
      fauxAssistantMessage("three"),
      fauxAssistantMessage("four"),
      fauxAssistantMessage("root"),
    ]);
    const answer = await new RLM(
      {
        model: faux.getModel(),
        context: "",
        maxDepth: 1,
        maxDeepChildren: 4,
        onEvent: (event) => events.push(event),
      },
      { streamFn: faux.streamSimple },
    ).run("root");

    assert.equal(answer, "root");
    assert.equal(events.filter((event) => event.type === "child_spawn").length, 4);
    assert.ok(
      events.some(
        (event) =>
          event.type === "javascript_end" &&
          event.isError === false &&
          event.output.includes("maximum deep children 4 reached"),
      ),
    );
  });

  test("rejects forged handles from a sibling run", async () => {
    const events: RLMEvent[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript('const h = await ctx.rlm.spawn("child"); await ctx.rlm.waitAll([h])'),
      javascript(
        'await ctx.rlm.result({ id: 1, name: "child-1", parentRunId: 0, depth: 1, tier: "balanced" })',
      ),
      fauxAssistantMessage("child recovered"),
      fauxAssistantMessage("root result"),
    ]);
    const answer = await new RLM(
      {
        model: faux.getModel(),
        context: "",
        maxDepth: 2,
        onEvent: (event) => events.push(event),
      },
      { streamFn: faux.streamSimple },
    ).run("root");

    assert.equal(answer, "root result");
    assert.ok(
      events.some(
        (event) =>
          event.type === "javascript_end" &&
          event.depth === 1 &&
          event.isError &&
          event.output.includes("does not belong to this run"),
      ),
    );
  });

  test("returns a strict invalid-tier error from the worker", async () => {
    const { JavaScriptRuntime } = await import("./runtime.ts");
    const runtime = new JavaScriptRuntime({
      context: "",
      rlm: {
        spawn: async () => ({ id: 1, name: "child-1", parentRunId: 0, depth: 1, tier: "balanced" }),
        waitAll: async () => [],
        result: async (handle) => ({ handle, tier: handle.tier, status: "pending" }),
        cancel: async (handle) => ({ handle, tier: handle.tier, status: "cancelled" }),
      },
    });
    try {
      const result = await runtime.execute('await ctx.rlm.spawn("bad", { tier: "bogus" })');
      assert.match(result.error?.message ?? "", /tier must be fast, balanced, or deep/);
    } finally {
      runtime.dispose();
    }
  });

  test("returns named host handles and terminal results without per-child usage claims", async () => {
    const events: RLMEvent[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      javascript(
        'const h = await ctx.rlm.spawn("child", { name: "worker", context: "selected" }); const r = (await ctx.rlm.waitAll([h]))[0]; ctx.console.log(h.id, h.name, h.parentRunId, h.depth, r.status, r.text, typeof r.usage)',
      ),
      fauxAssistantMessage("child result"),
      fauxAssistantMessage("root result"),
    ]);
    const result = await new RLM(
      {
        model: faux.getModel(),
        context: "root",
        maxDepth: 1,
        onEvent: (event) => events.push(event),
      },
      { streamFn: faux.streamSimple },
    ).run("root");
    assert.equal(result, "root result");
    assert.ok(
      events.some((event) => event.type === "child_end" && event.result.handle.name === "worker"),
    );
    assert.ok(
      events.every((event) => event.type !== "child_end" || event.result.usage === undefined),
    );
  });
});
