import { execAsync, extractErrorOutput } from "./exec-async.ts";
import type { GhStackCommandRunner } from "./github-stack.ts";
import { shellQuote } from "./shell-quote.ts";

export const MANAGED_DESCRIPTION_START = "fix-ci:pull-request:start";
export const MANAGED_DESCRIPTION_END = "fix-ci:pull-request:end";

export interface PullRequestDescription {
  branch: string;
  title: string;
  body: string;
}

export interface DescriptionIssue {
  branch: string;
  stage: "create" | "lookup" | "update" | "validate";
  error: string;
  output?: string;
}

export interface DescriptionResult {
  success: boolean;
  updated: string[];
  preserved: string[];
  issues: DescriptionIssue[];
}

function outputOf(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

function errorText(error: unknown): string {
  return extractErrorOutput(error).trim() || "unknown error";
}

function quoteAttribute(value: string): string {
  return JSON.stringify(value);
}

export function managedPullRequestDescription(
  description: PullRequestDescription,
  sha: string,
): string {
  return (
    `<!-- ${MANAGED_DESCRIPTION_START} branch=${quoteAttribute(description.branch)} sha=${quoteAttribute(sha)} -->\n` +
    description.body.trim() +
    `\n<!-- ${MANAGED_DESCRIPTION_END} -->`
  );
}

function markerExpression(): RegExp {
  return new RegExp(
    `<!-- ${MANAGED_DESCRIPTION_START.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")} branch=("(?:[^"\\\\]|\\\\.)*") sha=("(?:[^"\\\\]|\\\\.)*") -->\\s*[\\s\\S]*?<!-- ${MANAGED_DESCRIPTION_END.replace(/[.*+?^${}()|[\\\\]\\]/g, "\\$&")} -->`,
  );
}

export function stripGitHubStackBoilerplate(body: string): string {
  const boilerplate =
    /^\s*Stack created with \[GitHub Stacks CLI\]\([^)]+\)\s*[•·]\s*\[Give Feedback\]\([^)]+\)\s*(?:💬|🗨️?)?\s*$/;
  return body
    .split(/\r?\n/)
    .filter((line) => !boilerplate.test(line))
    .join("\n")
    .trim();
}

export function managedDescriptionSha(body: string, branch: string): string | null {
  const match = markerExpression().exec(body);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) === branch ? String(JSON.parse(match[2])).trim() || null : null;
  } catch {
    return null;
  }
}

export function refreshManagedPullRequestDescription(
  existingBody: string,
  description: PullRequestDescription,
  sha: string,
): string {
  const section = managedPullRequestDescription(description, sha);
  const expression = markerExpression();
  const cleanedBody = stripGitHubStackBoilerplate(existingBody);
  return expression.test(cleanedBody)
    ? cleanedBody.replace(expression, section)
    : cleanedBody.trimEnd() + (cleanedBody.trim() ? "\n\n" : "") + section + "\n";
}

export function newPullRequestBody(description: PullRequestDescription, sha: string): string {
  return managedPullRequestDescription(description, sha);
}

export async function getBranchSha(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await execAsync(
    `git rev-parse --verify ${shellQuote(`refs/heads/${branch}`)}^{commit}`,
    {
      cwd,
      timeout: 10_000,
      signal,
    },
  );
  const sha = result.stdout.trim();
  if (!sha) throw new Error(`could not resolve local SHA for ${branch}`);
  return sha;
}

async function lookup(
  cwd: string,
  branch: string,
  signal: AbortSignal | undefined,
  runner: GhStackCommandRunner,
): Promise<{ title: string; body: string }> {
  const result = await runner(["pr", "view", "--json", "number,title,body", "--", branch], {
    cwd,
    signal,
    timeout: 30_000,
  });
  const output = outputOf(result);
  try {
    const parsed = JSON.parse(result.stdout) as {
      number?: unknown;
      title?: unknown;
      body?: unknown;
    };
    if (
      !Number.isSafeInteger(parsed.number) ||
      (parsed.number as number) <= 0 ||
      typeof parsed.title !== "string" ||
      !parsed.title.trim() ||
      typeof parsed.body !== "string"
    ) {
      throw new Error("PR body lookup returned incomplete data");
    }
    return { title: parsed.title, body: parsed.body };
  } catch (error: unknown) {
    throw new Error(`${errorText(error)}${output.trim() ? `: ${output.trim()}` : ""}`);
  }
}

async function update(
  cwd: string,
  branch: string,
  title: string,
  body: string,
  signal: AbortSignal | undefined,
  runner: GhStackCommandRunner,
): Promise<void> {
  await runner(["pr", "edit", "--title", title, "--body", body, "--", branch], {
    cwd,
    signal,
    timeout: 30_000,
  });
}

export async function createDescribedStackPullRequests(
  cwd: string,
  branches: readonly string[],
  base: string,
  descriptions: readonly PullRequestDescription[],
  signal: AbortSignal | undefined,
  runner: GhStackCommandRunner,
): Promise<DescriptionResult> {
  const supplied = new Map(descriptions.map((description) => [description.branch, description]));
  const updated: string[] = [];
  const issues: DescriptionIssue[] = [];

  for (const branch of branches) {
    const description = supplied.get(branch);
    if (!description) {
      issues.push({ branch, stage: "validate", error: "authored title and body are required" });
      continue;
    }
    try {
      signal?.throwIfAborted();
      const sha = await getBranchSha(cwd, branch, signal);
      await runner(
        [
          "pr",
          "create",
          "--draft",
          "--title",
          description.title,
          "--body",
          newPullRequestBody(description, sha),
          "--head",
          branch,
          "--base",
          base,
        ],
        { cwd, signal, timeout: 30_000 },
      );
      signal?.throwIfAborted();
      updated.push(branch);
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      issues.push({ branch, stage: "create", error: errorText(error) });
    }
  }

  return { success: issues.length === 0, updated, preserved: [], issues };
}

/** Ensure all named branches have a current section; only that section is edited. */
export async function ensureManagedPullRequestDescriptions(
  cwd: string,
  branches: readonly string[],
  descriptions: readonly PullRequestDescription[],
  signal: AbortSignal | undefined,
  runner: GhStackCommandRunner,
): Promise<DescriptionResult> {
  const supplied = new Map(descriptions.map((description) => [description.branch, description]));
  const updated: string[] = [];
  const preserved: string[] = [];
  const issues: DescriptionIssue[] = [];

  for (const branch of branches) {
    let pr: { title: string; body: string };
    let sha: string;
    try {
      signal?.throwIfAborted();
      [pr, sha] = await Promise.all([
        lookup(cwd, branch, signal, runner),
        getBranchSha(cwd, branch, signal),
      ]);
      signal?.throwIfAborted();
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      issues.push({ branch, stage: "lookup", error: errorText(error) });
      continue;
    }

    const existingSha = managedDescriptionSha(pr.body, branch);
    const description = supplied.get(branch);
    if (existingSha === sha && !description) {
      const cleanedBody = stripGitHubStackBoilerplate(pr.body);
      if (cleanedBody === pr.body.trim()) {
        preserved.push(branch);
        continue;
      }
      try {
        await update(cwd, branch, pr.title, cleanedBody, signal, runner);
        updated.push(branch);
      } catch (error: unknown) {
        if (signal?.aborted) throw error;
        issues.push({ branch, stage: "update", error: errorText(error) });
      }
      continue;
    }
    if (!description || !description.title.trim() || !description.body.trim()) {
      issues.push({
        branch,
        stage: "validate",
        error: existingSha
          ? `managed description is stale (records SHA ${existingSha}, current SHA ${sha}); provide pull_requests entry with refreshed title and body`
          : `managed description is missing for current SHA ${sha}; provide pull_requests entry with title and body`,
      });
      continue;
    }
    try {
      signal?.throwIfAborted();
      await update(
        cwd,
        branch,
        description.title,
        refreshManagedPullRequestDescription(pr.body, description, sha),
        signal,
        runner,
      );
      signal?.throwIfAborted();
      updated.push(branch);
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      issues.push({ branch, stage: "update", error: errorText(error) });
    }
  }
  return { success: issues.length === 0, updated, preserved, issues };
}
