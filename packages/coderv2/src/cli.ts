#!/usr/bin/env node
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRunState, loadContract } from "./contract.ts";
import { Controller } from "./controller.ts";
import { ModelPlanner } from "./model-planner.ts";
import { ScriptedPlanner, type Planner } from "./planner.ts";
import { JsonStateStore } from "./store.ts";
import type { PlannerDecision } from "./types.ts";

function option(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function decisions(path: string): Promise<PlannerDecision[]> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("Planner script must contain a JSON array");
  return value as PlannerDecision[];
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const runs = resolve(option(args, "--runs", ".coderv2/runs")!);
  const store = new JsonStateStore(runs);

  if (command === "inspect") {
    const runId = args.find((arg) => !arg.startsWith("--"));
    if (!runId) throw new Error("Usage: coderv2 inspect <run-id> [--runs path]");
    console.log(JSON.stringify(await store.load(runId), null, 2));
    return;
  }

  const script = option(args, "--script");
  let planner: Planner;
  if (script) {
    planner = new ScriptedPlanner(await decisions(resolve(script)));
  } else {
    const provider = option(args, "--provider", "openai-codex")!;
    const modelId = option(args, "--model", "gpt-5.4")!;
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    if (!(await runtime.getAuth(model))) {
      throw new Error(`No configured authentication for ${provider}; authenticate with Pi first`);
    }
    const reasoning = option(args, "--reasoning", "medium")!;
    if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning)) {
      throw new Error("--reasoning must be minimal, low, medium, high, xhigh, or max");
    }
    planner = new ModelPlanner(runtime, model, {
      reasoningEffort: reasoning as ThinkingLevel,
    });
  }
  const maxSteps = Number(option(args, "--max-steps", "100"));
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new Error("--max-steps must be a positive integer");
  }
  const controller = new Controller(planner, store, undefined, { maxSteps });
  let state;
  if (command === "resume") {
    const runId = args.find((arg) => !arg.startsWith("--"));
    if (!runId) throw new Error("Usage: coderv2 resume <run-id> [model options]");
    state = await store.load(runId);
  } else if (command === "run") {
    const contractPath = option(args, "--contract");
    if (!contractPath)
      throw new Error("Usage: coderv2 run --contract task.json --repo . [model options]");
    state = await createRunState(
      await loadContract(resolve(contractPath)),
      option(args, "--repo", ".")!,
    );
    await store.save(state);
  } else {
    throw new Error("Usage: coderv2 <run|resume|inspect> ...");
  }
  const result = await controller.run(state);
  console.log(
    JSON.stringify({ runId: result.runId, status: result.objectives.root?.status }, null, 2),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
