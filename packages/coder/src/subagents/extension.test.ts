import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSubagentDefinitions } from "./definitions.ts";
import {
  createSubagentToolsExtension,
  finishSubagentToolExecution,
  formatSubagentResult,
  formatSubagentToolExecution,
  startSubagentToolExecution,
} from "./extension.ts";

test("only parent-prompted agents expose a task parameter", () => {
  const definitions = loadSubagentDefinitions([
    new URL("../../agents/scout.md", import.meta.url),
    new URL("../../agents/merge-conflicts.md", import.meta.url),
  ]);
  const registered: Array<{
    name: string;
    parameters: { properties?: Record<string, unknown> };
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

  const parameterNames = (name: string) =>
    Object.keys(registered.find((tool) => tool.name === name)!.parameters.properties ?? {});
  assert.deepEqual(parameterNames("scout"), ["task"]);
  assert.deepEqual(parameterNames("merge_conflicts"), []);
});

test("runs a code-owned workflow instead of a single prompt", async () => {
  let registered: { execute: (...args: any[]) => Promise<any> } | undefined;
  let workflowRuns = 0;
  let disposed = false;
  let inheritedTools: string[] | undefined;
  const definition = loadSubagentDefinitions([
    new URL("../../agents/scout.md", import.meta.url),
    new URL("../../agents/merge-conflicts.md", import.meta.url),
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
      return ["read", "merge_conflicts"];
    },
    registerTool(tool) {
      registered = tool as typeof registered;
    },
  } as never);

  const result = await registered!.execute("call", {}, undefined, undefined, { cwd: "." });

  assert.equal(workflowRuns, 1);
  assert.deepEqual(inheritedTools, ["read", "merge_conflicts"]);
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
