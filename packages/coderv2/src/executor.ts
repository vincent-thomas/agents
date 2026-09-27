import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { hash, repositoryFingerprint, trackedFiles } from "./fingerprint.ts";
import type { Action, ActionObservation, EffectBoundary, FileSnapshot } from "./types.ts";

export class InvalidActionError extends Error {}

function inside(repo: string, path = "."): string {
  const resolved = resolve(repo, path);
  const rel = relative(repo, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new InvalidActionError(`Path escapes repository: ${path}`);
  }
  return resolved;
}

async function snapshots(repo: string): Promise<FileSnapshot[]> {
  const files = await trackedFiles(repo);
  return Promise.all(
    files.map(async (path) => ({ path, hash: hash(await readFile(join(repo, path))) })),
  );
}

function changed(before: FileSnapshot[], after: FileSnapshot[]): string[] {
  const a = new Map(before.map((file) => [file.path, file.hash]));
  const b = new Map(after.map((file) => [file.path, file.hash]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((path) => a.get(path) !== b.get(path))
    .sort();
}

function allowed(path: string, boundaries: EffectBoundary[]): boolean {
  return boundaries.some((boundary) => {
    const prefix = boundary.path.replace(/^\.\//, "").replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

async function run(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((complete) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      complete({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      complete({ exitCode, stdout, stderr, timedOut });
    });
  });
}

export interface ExecutorOptions {
  defaultTimeoutMs?: number;
}

export class Executor {
  private readonly repo: string;
  private readonly allowedEffects: EffectBoundary[];
  private readonly options: ExecutorOptions;

  constructor(repo: string, allowedEffects: EffectBoundary[], options: ExecutorOptions = {}) {
    this.repo = repo;
    this.allowedEffects = allowedEffects;
    this.options = options;
  }

  async execute(action: Action): Promise<ActionObservation> {
    if (!["inspect", "search", "command", "edit"].includes(action.type)) {
      throw new InvalidActionError(`Action ${action.type} is not executable`);
    }
    const actionId = randomUUID();
    const startedAt = new Date().toISOString();
    const filesBefore = await snapshots(this.repo);
    const repositoryFingerprintBefore = await repositoryFingerprint(this.repo);
    let result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

    if (action.type === "inspect") {
      const contents = await Promise.all(
        action.paths.map(async (path) => ({
          path,
          content: await readFile(inside(this.repo, path), "utf8"),
        })),
      );
      result = { exitCode: 0, stdout: JSON.stringify(contents), stderr: "", timedOut: false };
    } else if (action.type === "search") {
      const args = ["--line-number", "--", action.query, ...(action.paths ?? ["."])];
      for (const path of action.paths ?? ["."]) inside(this.repo, path);
      result = await run(
        `rg ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
        this.repo,
        30_000,
      );
    } else if (action.type === "edit") {
      result = await new Promise((complete) => {
        const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
          cwd: this.repo,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.once("close", (exitCode) => complete({ exitCode, stdout, stderr, timedOut: false }));
        child.stdin.end(action.patch);
      });
    } else {
      result = await run(
        action.command,
        inside(this.repo, action.cwd),
        action.timeoutMs ?? this.options.defaultTimeoutMs ?? 120_000,
      );
    }

    const filesAfter = await snapshots(this.repo);
    const changedFiles = changed(filesBefore, filesAfter);
    const unexpectedFiles = changedFiles.filter((path) => !allowed(path, this.allowedEffects));
    return {
      actionId,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      filesBefore,
      filesAfter,
      changedFiles,
      unexpectedFiles,
      repositoryFingerprintBefore,
      repositoryFingerprintAfter: await repositoryFingerprint(this.repo),
    };
  }
}
