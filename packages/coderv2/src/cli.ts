#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRunState, loadContract } from "./contract.ts";
import { Controller } from "./controller.ts";
import { ScriptedPlanner } from "./planner.ts";
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
  if (!script) throw new Error(`${command ?? "run"} requires --script <decisions.json> in the MVP`);
  const planner = new ScriptedPlanner(await decisions(resolve(script)));
  const controller = new Controller(planner, store);
  let state;
  if (command === "resume") {
    const runId = args.find((arg) => !arg.startsWith("--"));
    if (!runId) throw new Error("Usage: coderv2 resume <run-id> --script decisions.json");
    state = await store.load(runId);
  } else if (command === "run") {
    const contractPath = option(args, "--contract");
    if (!contractPath)
      throw new Error("Usage: coderv2 run --contract task.json --repo . --script decisions.json");
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
