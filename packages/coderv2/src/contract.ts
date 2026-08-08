import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repositoryFingerprint } from "./fingerprint.ts";
import type { RunState, TaskContract } from "./types.ts";

export function validateContract(value: unknown): asserts value is TaskContract {
  if (!value || typeof value !== "object") throw new Error("Contract must be an object");
  const contract = value as Record<string, unknown>;
  if (typeof contract.intent !== "string" || !contract.intent.trim())
    throw new Error("Contract intent is required");
  for (const key of ["successCriteria", "invariants", "allowedEffects"] as const) {
    if (!Array.isArray(contract[key])) throw new Error(`Contract ${key} must be an array`);
  }
  for (const predicate of [...contract.successCriteria, ...contract.invariants] as unknown[]) {
    if (!predicate || typeof predicate !== "object") throw new Error("Predicates must be objects");
    const candidate = predicate as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.description !== "string" ||
      !candidate.requirement ||
      typeof candidate.requirement !== "object" ||
      typeof (candidate.requirement as Record<string, unknown>).type !== "string"
    ) {
      throw new Error("Predicate id, description, and typed requirement are required");
    }
  }
  for (const boundary of contract.allowedEffects as unknown[]) {
    if (
      !boundary ||
      typeof boundary !== "object" ||
      typeof (boundary as Record<string, unknown>).path !== "string"
    ) {
      throw new Error("Allowed effects require a path");
    }
  }
}

export async function loadContract(path: string): Promise<TaskContract> {
  const contract: unknown = JSON.parse(await readFile(path, "utf8"));
  validateContract(contract);
  return contract;
}

export async function createRunState(contract: TaskContract, repoPath: string): Promise<RunState> {
  const runId = randomUUID();
  const objectiveId = "root";
  const now = new Date().toISOString();
  const repo = resolve(repoPath);
  return {
    schemaVersion: 1,
    runId,
    repoPath: repo,
    repositoryFingerprint: await repositoryFingerprint(repo),
    contract,
    objectives: {
      [objectiveId]: {
        id: objectiveId,
        intent: contract.intent,
        status: "active",
        prerequisites: [],
        successCriteria: contract.successCriteria,
        invariants: contract.invariants,
        children: [],
        evidence: [],
        unresolvedQuestions: [],
      },
    },
    activeObjectiveId: objectiveId,
    claims: [],
    evidence: [],
    attempts: [],
    blockers: [],
    createdAt: now,
    updatedAt: now,
  };
}
