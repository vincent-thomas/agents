import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRunState } from "../src/contract.ts";
import type { Evidence, RunState, TaskContract } from "../src/types.ts";

const execFileAsync = promisify(execFile);

export async function tempRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "coderv2-repo-"));
  await execFileAsync("git", ["init", "-q", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  return repo;
}

export const contract: TaskContract = {
  intent: "Create a proof file and verify it",
  successCriteria: [
    {
      id: "changed",
      description: "proof file changed",
      requirement: { type: "path_changed", path: "proof.txt" },
    },
    {
      id: "verified",
      description: "verification passes",
      requirement: { type: "test_passed", command: "test -f proof.txt" },
    },
  ],
  invariants: [],
  allowedEffects: [{ path: "proof.txt" }],
};

export async function state(repo: string): Promise<RunState> {
  return createRunState(contract, repo);
}

export function commandEvidence(
  run: RunState,
  overrides: Partial<Extract<Evidence, { type: "command" }>> = {},
): Extract<Evidence, { type: "command" }> {
  return {
    id: "command-1",
    type: "command",
    createdAt: new Date().toISOString(),
    objectiveId: "root",
    repositoryFingerprint: run.repositoryFingerprint,
    actionId: "action-1",
    command: "true",
    cwd: ".",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    ...overrides,
  };
}
