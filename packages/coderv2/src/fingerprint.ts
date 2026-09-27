import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(repo: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", repo, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout;
}

export async function repositoryFingerprint(repo: string): Promise<string> {
  try {
    const [head, status, diff, cached] = await Promise.all([
      git(repo, ["rev-parse", "HEAD"]),
      git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
      git(repo, ["diff", "--binary"]),
      git(repo, ["diff", "--binary", "--cached"]),
    ]);
    const untracked = status
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3))
      .sort();
    const contents = await Promise.all(
      untracked.map(async (path) => `${path}\0${hash(await readFile(join(repo, path)))}`),
    );
    return hash([head.trim(), status, diff, cached, ...contents].join("\0"));
  } catch {
    return hash(repo);
  }
}

export async function trackedFiles(repo: string): Promise<string[]> {
  const output = await git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  return output.split("\n").filter(Boolean).sort();
}
