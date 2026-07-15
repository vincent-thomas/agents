/**
 * exec-async.ts — shared async exec with abort-signal support.
 *
 * Provides a promisified child_process.exec that:
 *  - Threads through AbortSignal (Ctrl+C kills child processes)
 *  - Attaches stdout/stderr to the rejection error for callers that need them
 *
 * Self-contained copy, private to @vt-pi/fix-ci: a package keeps its own copy
 * of helpers resembling packages/agent-lord/lib/ rather than importing across
 * that boundary.
 */

import { exec, type ChildProcess } from "node:child_process";

interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Options accepted by execAsync and its read-only convenience wrappers. */
export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
}

// node:child_process.exec defaults maxBuffer to 1MB per stream (stdout,
// stderr checked separately) and kills the child if either is exceeded —
// not truncates, kills, so the caller gets nothing at all. Several callers
// legitimately produce more than that: `gh run view --log` on a verbose CI
// run, or `gh api --paginate` against a PR with many check runs. Raised well
// above any of this codebase's real payloads while still bounding a runaway
// process.
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

/** An exec failure, with stdout/stderr attached so callers can show what the command actually printed. */
interface ExecError extends Error {
  stdout: string;
  stderr: string;
}

/**
 * Async exec that kills the child process when the signal fires.
 * Rejects on non-zero exit or timeout.
 */
export function execAsync(command: string, options: ExecOptions): Promise<ExecResult> {
  if (options.signal?.aborted) {
    return Promise.reject(
      Object.assign(new Error("The operation was aborted."), {
        stdout: "",
        stderr: "AbortError: signal already aborted",
      }),
    );
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess;

    const onAbort = () => {
      child.kill();
    };

    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    child = exec(
      command,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        cleanup();
        if (err) {
          // Attach stdout/stderr to the error for callers that need them.
          const execError = err as ExecError;
          execError.stdout = stdout;
          execError.stderr = stderr;
          reject(execError);
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );

    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Extract readable output from an exec error.
 * Prefers stderr, then stdout, falls back to toString.
 */
export function extractErrorOutput(err: unknown): string {
  if (err instanceof Error) {
    const { stdout, stderr } = err as Partial<ExecError>;
    if (stderr) return stderr;
    if (stdout) return stdout;
  }
  return String(err);
}

/**
 * Run a read-only command and return its trimmed stdout, or null if the
 * command fails or produces no output. The workhorse for the many
 * "look something up, don't care why it failed" git/gh queries — collapses
 * both a non-zero exit and empty output to null so callers get one uniform
 * "no answer" signal instead of hand-rolling a try/catch each time.
 */
export async function tryExec(command: string, options: ExecOptions): Promise<string | null> {
  try {
    const { stdout } = await execAsync(command, options);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run a command purely for its exit status: true if it exited 0, false if it
 * failed. For probes like `git diff --cached --quiet` or
 * `git merge-base --is-ancestor` whose whole answer is the exit code, not the
 * output.
 */
export async function execSucceeds(command: string, options: ExecOptions): Promise<boolean> {
  try {
    await execAsync(command, options);
    return true;
  } catch {
    return false;
  }
}
