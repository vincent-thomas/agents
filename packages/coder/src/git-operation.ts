import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "none";

export type GitCommandOutputFn = (
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;

export async function refExists(
  ref: string,
  cwd: string,
  commandOutput: GitCommandOutputFn,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await commandOutput("git", ["rev-parse", "--verify", "-q", ref], cwd, signal);
    return true;
  } catch {
    return false;
  }
}

export async function gitPathExists(
  path: string,
  cwd: string,
  commandOutput: GitCommandOutputFn,
  signal?: AbortSignal,
  pathExists: (path: string) => boolean = existsSync,
): Promise<boolean> {
  const gitPath = (
    await commandOutput("git", ["rev-parse", "--git-path", path], cwd, signal)
  ).trim();
  return gitPath !== "" && pathExists(resolve(cwd, gitPath));
}

export async function detectGitOperation(
  cwd: string,
  commandOutput: GitCommandOutputFn,
  signal?: AbortSignal,
  pathExists: (path: string) => boolean = existsSync,
): Promise<GitOperation> {
  if (await refExists("MERGE_HEAD", cwd, commandOutput, signal)) return "merge";
  if (await refExists("CHERRY_PICK_HEAD", cwd, commandOutput, signal)) return "cherry-pick";
  if (await refExists("REVERT_HEAD", cwd, commandOutput, signal)) return "revert";
  if (
    (await gitPathExists("rebase-merge", cwd, commandOutput, signal, pathExists)) ||
    (await gitPathExists("rebase-apply", cwd, commandOutput, signal, pathExists))
  ) {
    return "rebase";
  }
  return "none";
}
