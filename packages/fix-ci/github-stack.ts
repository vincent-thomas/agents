/**
 * Safe wrappers for the official `gh stack` commands.
 *
 * Keep the command boundary here: arguments are passed to `execFile`, never
 * through a shell.  The runner is injectable so stack orchestration can be
 * tested without requiring a GitHub CLI installation or network access.
 */
import { execFile } from "node:child_process";

export interface GhStackCommandOptions {
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface GhStackCommandResult {
  stdout: string;
  stderr: string;
}

export type GhStackCommandRunner = (
  args: readonly string[],
  options: GhStackCommandOptions,
) => Promise<GhStackCommandResult>;

/** Add a non-persistent rerere setting while preserving existing Git config entries. */
export function withRerereGitConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const configuredCount = env.GIT_CONFIG_COUNT;
  const parsedCount =
    configuredCount !== undefined && /^[0-9]+$/.test(configuredCount)
      ? Number(configuredCount)
      : NaN;
  const count =
    Number.isSafeInteger(parsedCount) && parsedCount < Number.MAX_SAFE_INTEGER ? parsedCount : 0;
  const next = { ...env };
  next.GIT_CONFIG_COUNT = String(count + 1);
  next[`GIT_CONFIG_KEY_${count}`] = "rerere.enabled";
  next[`GIT_CONFIG_VALUE_${count}`] = "true";
  return next;
}

interface GhStackCommandError extends Error {
  stdout?: string;
  stderr?: string;
}

/** The default command runner. It deliberately does not invoke a shell. */
export const runGhStackCommand: GhStackCommandRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 30_000,
        signal: options.signal,
        env: withRerereGitConfig({
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
        }),
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = error as GhStackCommandError;
          commandError.stdout = String(stdout ?? "");
          commandError.stderr = String(stderr ?? "");
          reject(commandError);
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

function commandOutput(result: GhStackCommandResult): string {
  return result.stdout + result.stderr;
}

function errorOutput(error: unknown): string {
  if (error instanceof Error) {
    const commandError = error as GhStackCommandError;
    const output = [commandError.stdout, commandError.stderr].filter(Boolean).join("\n");
    if (output) return output;
    return error.message;
  }
  return String(error);
}

export interface GhStackOperationResult {
  success: boolean;
  output: string;
}

export type WorkspaceBranchRestorer = (
  cwd: string,
  branch: string,
  signal?: AbortSignal,
) => Promise<GhStackOperationResult>;

/** Restore the host-owned branch after a stack command traverses clean branches. */
export const restoreWorkspaceBranch: WorkspaceBranchRestorer = (cwd, branch, signal) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["switch", "--", branch],
      {
        cwd,
        signal,
        timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        const result = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
        if (error) {
          const commandError = error as GhStackCommandError;
          commandError.stdout = result.stdout;
          commandError.stderr = result.stderr;
          resolve({ success: false, output: errorOutput(commandError) });
          return;
        }
        resolve({ success: true, output: commandOutput(result) });
      },
    );
  });

async function runStackOperation(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  runner: GhStackCommandRunner,
): Promise<GhStackOperationResult> {
  try {
    const result = await runner(args, { cwd, signal, timeout: 5 * 60_000 });
    return { success: true, output: commandOutput(result) };
  } catch (error: unknown) {
    return { success: false, output: errorOutput(error) };
  }
}

export function stackInitArgs(branches: readonly string[], base?: string): string[] {
  return ["stack", "init", ...(base ? ["--base", base] : []), "--", ...branches];
}

export function stackViewArgs(): string[] {
  return ["stack", "view", "--json"];
}

export function stackSyncArgs(): string[] {
  return ["stack", "sync"];
}

export function stackSubmitArgs(): string[] {
  return ["stack", "submit", "--auto", "--no-comments"];
}

export function runGhStackInit(
  cwd: string,
  branches: readonly string[],
  base?: string,
  signal?: AbortSignal,
  runner: GhStackCommandRunner = runGhStackCommand,
): Promise<GhStackOperationResult> {
  return runStackOperation(stackInitArgs(branches, base), cwd, signal, runner);
}

export function runGhStackSync(
  cwd: string,
  signal?: AbortSignal,
  runner: GhStackCommandRunner = runGhStackCommand,
): Promise<GhStackOperationResult> {
  return runStackOperation(stackSyncArgs(), cwd, signal, runner);
}

export function runGhStackSubmit(
  cwd: string,
  signal?: AbortSignal,
  runner: GhStackCommandRunner = runGhStackCommand,
): Promise<GhStackOperationResult> {
  return runStackOperation(stackSubmitArgs(), cwd, signal, runner);
}

export type GhStackProbeStatus = "stacked" | "unstacked" | "error";

export interface GhStackProbeResult {
  status: GhStackProbeStatus;
  output: string;
  branches: string[];
}

/**
 * `gh stack view` exits non-zero for an ordinary, non-stacked branch. Only its
 * explicit "not part of a stack" errors confirm that state; missing extensions,
 * authentication failures, and malformed successful output remain hard errors.
 */
export async function probeGhStack(
  cwd: string,
  signal?: AbortSignal,
  runner: GhStackCommandRunner = runGhStackCommand,
): Promise<GhStackProbeResult> {
  try {
    const result = await runner(stackViewArgs(), { cwd, signal });
    const output = commandOutput(result);
    const parsed = parseStackBranchNames(result.stdout);
    return {
      status:
        isStackViewStacked(result.stdout) && parsed.complete && parsed.branches.length > 0
          ? "stacked"
          : "error",
      output: output || "gh stack view returned no recognizable stack data",
      branches: parsed.branches,
    };
  } catch (error: unknown) {
    const output = errorOutput(error);
    return {
      status: isNotStackOutput(output) ? "unstacked" : "error",
      output,
      branches: [],
    };
  }
}

export function isNotStackOutput(output: string): boolean {
  return (
    /(?:current )?branch .+ is not part of a stack/i.test(output) ||
    /no stack found for branch /i.test(output)
  );
}

/**
 * Parse the JSON emitted by `gh stack view --json`. The CLI has changed the
 * surrounding object shape between releases, so identify a stack by its
 * branch/entry collections rather than depending on one release's schema.
 */
export function isStackViewStacked(output: string): boolean {
  try {
    return hasStackEntries(JSON.parse(output) as unknown);
  } catch {
    return false;
  }
}

/** Extract stack branch names from the supported `gh stack view --json` shapes. */
export function stackBranchNames(output: string): string[] {
  return parseStackBranchNames(output).branches;
}

function parseStackBranchNames(output: string): { branches: string[]; complete: boolean } {
  try {
    const branches: string[] = [];
    const complete = collectStackRoot(JSON.parse(output) as unknown, branches);
    return { branches, complete };
  } catch {
    return { branches: [], complete: false };
  }
}

function addBranch(branches: string[], value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  if (!branches.includes(value)) branches.push(value);
  return true;
}

function collectStackRoot(value: unknown, branches: string[]): boolean {
  if (Array.isArray(value)) return collectBranchCollection(value, branches);
  if (!value || typeof value !== "object") return false;

  const object = value as Record<string, unknown>;
  let foundCollection = false;
  let collectionsComplete = true;
  for (const key of ["stack", "branches", "entries", "commits"]) {
    if (!(key in object)) continue;
    foundCollection = true;
    if (!collectBranchCollection(object[key], branches)) collectionsComplete = false;
  }
  if (foundCollection) {
    for (const fallback of ["currentBranch", "current", "head", "branch"]) {
      addBranch(branches, object[fallback]);
    }
    return collectionsComplete;
  }

  for (const key of [
    "branch",
    "branchName",
    "headBranch",
    "headRefName",
    "currentBranch",
    "current",
    "head",
  ]) {
    if (addBranch(branches, object[key])) return true;
  }
  return false;
}

function collectBranchCollection(value: unknown, branches: string[]): boolean {
  if (typeof value === "string") return addBranch(branches, value);
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    let complete = true;
    for (const entry of value) {
      if (!collectBranchEntry(entry, branches)) complete = false;
    }
    return complete;
  }
  return collectBranchEntry(value, branches);
}

function collectBranchEntry(value: unknown, branches: string[]): boolean {
  if (typeof value === "string") return addBranch(branches, value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const object = value as Record<string, unknown>;
  for (const key of ["branch", "branchName", "headBranch", "headRefName", "name"]) {
    if (addBranch(branches, object[key])) return true;
  }
  return collectStackRoot(object, branches);
}

function hasStackEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== "object") return false;

  const object = value as Record<string, unknown>;
  for (const key of ["stack", "branches", "entries", "commits"]) {
    const entries = object[key];
    if (Array.isArray(entries) && entries.length > 0) return true;
    if (entries && typeof entries === "object" && hasStackEntries(entries)) return true;
  }

  // Some versions return one current branch object rather than a collection.
  for (const key of ["branch", "currentBranch", "current", "head"]) {
    if (typeof object[key] === "string" && object[key].trim().length > 0) return true;
  }

  return false;
}
