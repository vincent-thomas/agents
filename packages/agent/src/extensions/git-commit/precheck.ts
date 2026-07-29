/**
 * precheck.ts — pre-commit / pre-push validation helper.
 *
 * Runs `make` if a Makefile exists and make is available. The project
 * defines what "valid" means through its Makefile — no harness-side
 * project-type detection.
 *
 * No pi imports — importable from any extension's logic module.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execAsync, extractErrorOutput } from "./exec-async.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreCheckResult {
  passed: boolean;
  steps: { command: string; passed: boolean; output: string; elapsed?: string }[];
}

export function formatSuccessfulPreChecks(result: PreCheckResult): string {
  if (result.steps.length === 0) {
    return "Project validation skipped: no Makefile or `make` unavailable.";
  }
  return `Project validation passed: ${result.steps.map((step) => `\`${step.command}\``).join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Pre-check runner
// ---------------------------------------------------------------------------

/**
 * Run `make` as a pre-check if a Makefile exists and make is available.
 *
 * Returns immediately with `{ passed: true, steps: [] }` if either
 * condition is not met. Otherwise runs `make` and reports the result.
 */
export async function runPreChecks(
  cwd: string,
  signal?: AbortSignal,
  onStep?: (step: PreCheckResult["steps"][0]) => void,
): Promise<PreCheckResult> {
  // Skip if no Makefile exists.
  if (!existsSync(resolve(cwd, "Makefile"))) {
    return { passed: true, steps: [] };
  }

  // Skip if make isn't installed. `command -v` is a POSIX shell builtin, so
  // unlike `which` it works even in minimal environments that don't ship a
  // standalone `which` binary (e.g. this repo's own nix build sandbox).
  try {
    await execAsync("command -v make", { cwd, timeout: 5_000, signal });
  } catch {
    return { passed: true, steps: [] };
  }

  const command = "make";
  const start = Date.now();

  let passed: boolean;
  let output: string;
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 600_000, signal });
    passed = true;
    output = stdout + stderr;
  } catch (err: unknown) {
    passed = false;
    output = extractErrorOutput(err);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const step = { command, passed, output, elapsed };
  onStep?.(step);
  return { passed, steps: [step] };
}
