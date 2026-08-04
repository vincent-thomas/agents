import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSubagentDefinitions } from "./definitions.ts";
import {
  createSubagentCommandExtension,
  createSubagentToolsExtension,
  finishSubagentToolExecution,
  formatSubagentResult,
  formatSubagentToolExecution,
  startSubagentToolExecution,
  updateSubagentToolExecution,
} from "./extension.ts";

test("registers one agent tool with an actor-specific prompt schema", () => {
  const definitions = loadSubagentDefinitions([
    new URL("../../agents/scout.md", import.meta.url),
    new URL("../../agents/merge-conflicts.md", import.meta.url),
    new URL("../../agents/review.md", import.meta.url),
    new URL("../../agents/right-hand.md", import.meta.url),
  ]);
  const registered: Array<{
    name: string;
    parameters: { anyOf: Array<{ properties: Record<string, unknown> }> };
    renderCall: (
      args: { actor?: string },
      theme: unknown,
      context: unknown,
    ) => { render(width: number): string[] };
    renderResult: (...args: any[]) => { render(width: number): string[] };
  }> = [];
  const extension = createSubagentToolsExtension({
    definitions,
    invokeSubagent: async () => {
      throw new Error("not invoked");
    },
  });
  extension({
    registerTool(tool) {
      registered.push(tool as (typeof registered)[number]);
    },
  } as never);

  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.name, "agent");
  assert.deepEqual(
    registered[0]!.parameters.anyOf.map((variant) => Object.keys(variant.properties)),
    [["actor", "prompt"], ["actor"], ["actor", "prompt"], ["actor", "prompt"]],
  );

  const call = registered[0]!.renderCall(
    { actor: "scout" },
    {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    },
    {},
  );
  assert.deepEqual(call.render("agent scout".length), ["agent scout"]);

  const prompt = "Survey this repository";
  const partialResult = registered[0]!.renderResult(
    {
      content: [{ type: "text", text: "Working..." }],
      details: { toolTrace: [] },
    },
    { expanded: true, isPartial: true },
    { fg: (_color: string, text: string) => text },
    { args: { actor: "scout", prompt } },
  );
  assert.deepEqual(partialResult.render(prompt.length), [prompt]);
});

test("exposes a parent-prompted sub-agent as a slash command", async () => {
  const definition = loadSubagentDefinitions([
    new URL("../../agents/review.md", import.meta.url),
  ])[0]!;
  let command: { name: string; handler: (args: string, context: any) => Promise<void> } | undefined;
  let delegatedContext: unknown;
  let promptedWith: string | undefined;
  let disposed = false;
  const sent: unknown[] = [];
  const statuses: unknown[][] = [];
  const extension = createSubagentCommandExtension({
    definition,
    invokeSubagent: async (context) => {
      delegatedContext = context;
      return {
        prompt: context.parentPrompt!,
        subagent: {
          definition,
          session: {
            prompt: async (prompt: string) => {
              promptedWith = prompt;
            },
            getLastAssistantText: () => "No findings.",
          } as never,
          dispose: () => {
            disposed = true;
          },
        },
      };
    },
  });
  extension({
    getActiveTools: () => ["read", "review"],
    registerCommand(name, options) {
      command = { name, handler: options.handler };
    },
    sendMessage(message, options) {
      sent.push(message, options);
    },
  } as never);

  await command!.handler("focus on cancellation", {
    cwd: "/workspace",
    waitForIdle: async () => {},
    ui: {
      setStatus: (...args: unknown[]) => statuses.push(args),
      notify: () => {},
    },
  });

  assert.equal(command!.name, "review");
  assert.deepEqual(delegatedContext, {
    cwd: "/workspace",
    parentPrompt: "focus on cancellation",
    parentToolNames: ["read", "review"],
  });
  assert.equal(promptedWith, "focus on cancellation");
  assert.equal(disposed, true);
  assert.deepEqual(sent, [
    {
      customType: "subagent-feedback",
      content: "Review sub-agent feedback:\n\nNo findings.",
      display: true,
      details: { name: "review", task: "focus on cancellation" },
    },
    { triggerTurn: true },
  ]);
  assert.deepEqual(statuses.at(-1), ["subagent:review", undefined]);
});

test("runs a code-owned workflow instead of a single prompt", async () => {
  let registered: { execute: (...args: any[]) => Promise<any> } | undefined;
  let workflowRuns = 0;
  let disposed = false;
  let inheritedTools: string[] | undefined;
  const definition = loadSubagentDefinitions([
    new URL("../../agents/scout.md", import.meta.url),
    new URL("../../agents/merge-conflicts.md", import.meta.url),
    new URL("../../agents/review.md", import.meta.url),
    new URL("../../agents/right-hand.md", import.meta.url),
  ]).find((candidate) => candidate.name === "merge_conflicts")!;
  const extension = createSubagentToolsExtension({
    definitions: [definition],
    invokeSubagent: async (_definition, context) => {
      inheritedTools = context.parentToolNames;
      return {
        prompt: "initial prompt",
        subagent: {
          definition,
          session: {
            subscribe: () => () => {},
          } as never,
          dispose: () => {
            disposed = true;
          },
        },
        run: async () => {
          workflowRuns++;
          return "workflow complete";
        },
      };
    },
  });
  extension({
    getActiveTools() {
      return ["read", "agent"];
    },
    registerTool(tool) {
      registered = tool as typeof registered;
    },
  } as never);

  const result = await registered!.execute(
    "call",
    { actor: "merge_conflicts" },
    undefined,
    undefined,
    { cwd: "." },
  );

  assert.equal(workflowRuns, 1);
  assert.deepEqual(inheritedTools, ["read", "agent"]);
  assert.equal(disposed, true);
  assert.equal(result.content[0].text, "workflow complete");
});

test("formats a missing sub-agent response", () => {
  assert.equal(formatSubagentResult(undefined), "The sub-agent did not return an answer.");
  assert.equal(formatSubagentResult("   "), "The sub-agent did not return an answer.");
});

test("tracks nested tool executions without mutating earlier snapshots", () => {
  const empty = [];
  const running = startSubagentToolExecution(empty, "call-1", "read", {
    path: "src/index.ts",
    offset: 10,
    limit: 5,
  });
  const finished = finishSubagentToolExecution(running, "call-1", false);

  assert.deepEqual(empty, []);
  assert.equal(running[0]?.status, "running");
  assert.equal(finished[0]?.status, "succeeded");
  assert.equal(formatSubagentToolExecution(finished[0]!), "read src/index.ts:10-14");
});

test("attaches recursively propagated sub-agent details to tool snapshots", () => {
  const running = startSubagentToolExecution([], "call-1", "agent", {
    actor: "review",
    prompt: "inspect tests",
  });
  const child = {
    name: "review",
    label: "Review",
    prompt: "inspect tests",
    toolTrace: [startSubagentToolExecution([], "call-2", "grep", { pattern: "nested" })[0]!],
  };
  const updated = updateSubagentToolExecution(running, "call-1", {
    details: { subagent: child },
  });
  const finished = finishSubagentToolExecution(updated, "call-1", false, {
    details: { subagent: { ...child, result: "No findings." } },
  });

  assert.equal(running[0]?.subagent, undefined);
  assert.equal(updated[0]?.subagent?.toolTrace[0]?.name, "grep");
  assert.equal(finished[0]?.subagent?.result, "No findings.");
  assert.equal(
    updateSubagentToolExecution(running, "call-1", {
      details: { subagent: { label: "Malformed", toolTrace: null } },
    }),
    running,
  );
});

test("renders nested sub-agents as an indented recursive tree", () => {
  const definition = loadSubagentDefinitions([
    new URL("../../agents/right-hand.md", import.meta.url),
  ])[0]!;
  let registered:
    | { renderResult: (...args: any[]) => { render(width: number): string[] } }
    | undefined;
  createSubagentToolsExtension({
    definitions: [definition],
    invokeSubagent: async () => {
      throw new Error("not invoked");
    },
  })({
    registerTool(tool) {
      registered = tool as typeof registered;
    },
  } as never);
  const theme = {
    fg: (_color: string, text: string) => text,
  };
  const result = {
    content: [{ type: "text", text: "Done." }],
    details: {
      subagent: {
        name: "right_hand",
        label: "Right hand",
        prompt: "implement feature",
        result: "Done.",
        toolTrace: [
          {
            id: "read-1",
            name: "read",
            args: { path: "src/index.ts" },
            status: "succeeded",
          },
          {
            id: "agent-1",
            name: "agent",
            args: { actor: "review", prompt: "inspect tests\ncarefully" },
            status: "succeeded",
            subagent: {
              name: "review",
              label: "Review",
              prompt: "inspect tests\ncarefully",
              result: "No findings.",
              toolTrace: [
                {
                  id: "grep-1",
                  name: "grep",
                  args: { pattern: "nested", path: "packages" },
                  status: "succeeded",
                },
              ],
            },
          },
        ],
      },
    },
  };

  const rendered = registered!.renderResult(result, { expanded: true, isPartial: false }, theme, {
    args: { actor: "right_hand", prompt: "implement feature" },
  });

  assert.equal(
    rendered
      .render(120)
      .map((line) => line.trimEnd())
      .join("\n"),
    [
      "Right hand: implement feature",
      "",
      "Sub-agent tools:",
      "✓ read src/index.ts",
      "✓ Review: inspect tests",
      "  carefully",
      "",
      "  Sub-agent tools:",
      "  ✓ grep /nested/ in packages",
      "",
      "  No findings.",
      "",
      "Done.",
    ].join("\n"),
  );
});

test("renders persisted flat traces with their final result", () => {
  const definition = loadSubagentDefinitions([
    new URL("../../agents/right-hand.md", import.meta.url),
  ])[0]!;
  let registered:
    | { renderResult: (...args: any[]) => { render(width: number): string[] } }
    | undefined;
  createSubagentToolsExtension({
    definitions: [definition],
    invokeSubagent: async () => {
      throw new Error("not invoked");
    },
  })({
    registerTool(tool) {
      registered = tool as typeof registered;
    },
  } as never);

  const rendered = registered!.renderResult(
    {
      content: [{ type: "text", text: "Legacy response." }],
      details: {
        toolTrace: [
          {
            id: "read-1",
            name: "read",
            args: { path: "src/legacy.ts" },
            status: "succeeded",
          },
        ],
      },
    },
    { expanded: true, isPartial: false },
    { fg: (_color: string, text: string) => text },
    { args: { actor: "right_hand", prompt: "old task" } },
  );

  assert.equal(
    rendered
      .render(120)
      .map((line) => line.trimEnd())
      .join("\n"),
    [
      "Right Hand: old task",
      "",
      "Sub-agent tools:",
      "✓ read src/legacy.ts",
      "",
      "Legacy response.",
    ].join("\n"),
  );
});

test("formats every permitted nested tool", () => {
  const executions = [
    startSubagentToolExecution([], "1", "grep", {
      pattern: "retry",
      path: "packages",
    })[0]!,
    startSubagentToolExecution([], "2", "find", { pattern: "*.test.ts" })[0]!,
    startSubagentToolExecution([], "3", "ls", {})[0]!,
    startSubagentToolExecution([], "4", "bash", { command: "git status --short" })[0]!,
  ];

  assert.deepEqual(executions.map(formatSubagentToolExecution), [
    "grep /retry/ in packages",
    "find *.test.ts in .",
    "ls .",
    "$ git status --short",
  ]);
});
