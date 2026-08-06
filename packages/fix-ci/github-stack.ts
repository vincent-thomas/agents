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

export function stackCheckoutArgs(branch: string): string[] {
  return ["stack", "checkout", "--", branch];
}

export function stackUnstackArgs(): string[] {
  return ["stack", "unstack"];
}

export function stackUnstackLocalArgs(): string[] {
  return ["stack", "unstack", "--local"];
}

export function stackSyncArgs(): string[] {
  return ["stack", "sync"];
}

export function stackSubmitArgs(): string[] {
  return ["stack", "submit", "--auto"];
}

export function stackLinkArgs(branches: readonly string[], base?: string | null): string[] {
  return [
    "stack",
    "link",
    ...(base !== undefined && base !== null ? ["--base", base] : []),
    "--",
    ...branches,
  ];
}

/** Match only the gh stack rejection for inserting PRs in the middle. */
export function isMiddleInsertionRejectionOutput(output: string): boolean {
  const diagnostic = "Cannot update stack: new PRs must be added to the top of the existing stack";
  return output.split(/\r?\n/).some((line) => {
    const normalized = line.trim();
    const withoutLivePrefix = normalized.startsWith("✗ ") ? normalized.slice(2).trim() : normalized;
    return withoutLivePrefix === diagnostic;
  });
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

export function runGhStackCheckout(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
  runner: GhStackCommandRunner = runGhStackCommand,
): Promise<GhStackOperationResult> {
  return runStackOperation(stackCheckoutArgs(branch), cwd, signal, runner);
}

export function runGhStackUnstack(
  cwd: string,
  signal?: AbortSignal,
  runner: GhStackCommandRunner = runGhStackCommand,
): Promise<GhStackOperationResult> {
  return runStackOperation(stackUnstackArgs(), cwd, signal, runner);
}

export function runGhStackUnstackLocal(
  cwd: string,
  signal?: AbortSignal,
  runner: GhStackCommandRunner = runGhStackCommand,
): Promise<GhStackOperationResult> {
  return runStackOperation(stackUnstackLocalArgs(), cwd, signal, runner);
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

export function runGhStackLink(
  cwd: string,
  branches: readonly string[],
  base?: string | null,
  signal?: AbortSignal,
  runner: GhStackCommandRunner = runGhStackCommand,
): Promise<GhStackOperationResult> {
  return runStackOperation(stackLinkArgs(branches, base), cwd, signal, runner);
}

export type GhStackProbeStatus = "stacked" | "unstacked" | "error";

export interface GhStackProbeResult {
  status: GhStackProbeStatus;
  output: string;
  branches: string[];
  /** The stack trunk/base branch when the view JSON identifies it. */
  baseBranch: string | null;
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
    const enriched = parseGhStackView(result.stdout);
    const parsed = enriched
      ? { branches: enriched.branches.map((branch) => branch.name), complete: true }
      : parseStackBranchNames(result.stdout);
    return {
      status:
        isStackViewStacked(result.stdout) && parsed.complete && parsed.branches.length > 0
          ? "stacked"
          : "error",
      output: output || "gh stack view returned no recognizable stack data",
      branches: parsed.branches,
      baseBranch: enriched ? (enriched.trunk ?? enriched.base) : stackBaseBranch(result.stdout),
    };
  } catch (error: unknown) {
    const output = errorOutput(error);
    return {
      status: isNotStackOutput(output) ? "unstacked" : "error",
      output,
      branches: [],
      baseBranch: null,
    };
  }
}

export function isNotStackOutput(output: string): boolean {
  return (
    /(?:current )?branch .+ is not part of a stack/i.test(output) ||
    /no stack found for branch /i.test(output)
  );
}

export interface GhStackViewPullRequest {
  number: number;
  url: string | null;
  state: string;
}

/** One ordered branch as reported by the enriched official stack view JSON. */
export interface GhStackViewBranch {
  name: string;
  head: string | null;
  base: string | null;
  isCurrent: boolean;
  isMerged: boolean;
  isQueued: boolean;
  needsRebase: boolean;
  pr?: GhStackViewPullRequest;
}

/** The stable, typed subset of `gh stack view --json`. */
export interface GhStackView {
  trunk: string | null;
  base: string | null;
  currentBranch: string | null;
  branches: GhStackViewBranch[];
}

/**
 * Parse the enriched JSON emitted by the official `gh stack view --json`.
 *
 * This intentionally accepts only the enriched branch records. Older CLI
 * releases had several branch-name-only shapes; those remain supported by
 * `probeGhStack`, `stackBranchNames`, and `stackBaseBranch` below.
 */
export function parseGhStackView(output: string): GhStackView | null {
  try {
    const value = JSON.parse(output) as unknown;
    const root = stackViewObject(value);
    if (!root) return null;
    const outer =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : root;
    const collection = stackViewBranchCollection(root);
    if (!collection || collection.length === 0) return null;

    const branches: GhStackViewBranch[] = [];
    for (const entry of collection) {
      const branch = parseGhStackViewBranch(entry);
      if (!branch) return null;
      branches.push(branch);
    }

    return {
      trunk: stackViewRootBranch(outer, "trunk") ?? stackViewRootBranch(root, "trunk"),
      base: stackViewRootBranch(outer, "base") ?? stackViewRootBranch(root, "base"),
      currentBranch:
        branchLikeName(outer.currentBranch ?? outer.current) ??
        branchLikeName(root.currentBranch ?? root.current),
      branches,
    };
  } catch {
    return null;
  }
}

function stackViewObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (stackViewBranchCollection(object)) return object;
  if (object.stack && typeof object.stack === "object" && !Array.isArray(object.stack)) {
    return stackViewObject(object.stack);
  }
  return null;
}

function stackViewBranchCollection(object: Record<string, unknown>): unknown[] | null {
  for (const key of ["branches", "stack", "entries", "commits"]) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  return null;
}

function stackViewRootBranch(
  object: Record<string, unknown>,
  key: "trunk" | "base",
): string | null {
  const direct = branchLikeName(object[key]);
  if (direct) return direct;
  if (object.stack && typeof object.stack === "object" && !Array.isArray(object.stack)) {
    return stackViewRootBranch(object.stack as Record<string, unknown>, key);
  }
  return null;
}

function branchField(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  for (const key of ["ref", "name", "branch", "branchName", "sha"]) {
    if (typeof object[key] === "string" && object[key].trim()) return object[key].trim();
  }
  return null;
}

function parseGhStackViewBranch(value: unknown): GhStackViewBranch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const name = branchField(object.name);
  if (
    !name ||
    typeof object.isCurrent !== "boolean" ||
    typeof object.isMerged !== "boolean" ||
    typeof object.isQueued !== "boolean" ||
    typeof object.needsRebase !== "boolean"
  ) {
    return null;
  }

  const pullRequestValue = object.pr ?? object.pullRequest ?? object.pull_request ?? object.PR;
  const pr = parseGhStackViewPullRequest(pullRequestValue);
  if (pullRequestValue !== undefined && pullRequestValue !== null && !pr) return null;
  return {
    name,
    head: branchField(object.head),
    base: branchField(object.base),
    isCurrent: object.isCurrent,
    isMerged: object.isMerged,
    isQueued: object.isQueued,
    needsRebase: object.needsRebase,
    ...(pr ? { pr } : {}),
  };
}

function parseGhStackViewPullRequest(value: unknown): GhStackViewPullRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(object.number) ||
    (object.number as number) <= 0 ||
    typeof object.state !== "string" ||
    !object.state.trim() ||
    (object.url !== undefined &&
      object.url !== null &&
      (typeof object.url !== "string" || !object.url.trim()))
  ) {
    return null;
  }
  return {
    number: object.number as number,
    url: typeof object.url === "string" ? object.url.trim() : null,
    state: object.state.trim(),
  };
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

/** Extract the trunk/base branch from the root of a stack view JSON object. */
export function stackBaseBranch(output: string): string | null {
  try {
    return stackBaseBranchValue(JSON.parse(output) as unknown);
  } catch {
    return null;
  }
}

function stackBaseBranchValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const root = value as Record<string, unknown>;
  for (const key of ["trunk", "base", "trunkBranch", "baseBranch"]) {
    const branch = branchLikeName(root[key]);
    if (branch) return branch;
  }

  // A few gh versions wrap the root fields in an object under `stack`.
  // Deliberately do not walk branches/entries/commits: their `base` values
  // can be commit SHAs rather than the stack's base branch.
  return stackBaseBranchValue(root.stack);
}

function branchLikeName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const object = value as Record<string, unknown>;
  for (const key of [
    "branch",
    "branchName",
    "name",
    "headBranch",
    "headRefName",
    "refName",
    "currentBranch",
    "current",
    "head",
    "ref",
  ]) {
    if (typeof object[key] === "string" && object[key].trim()) return object[key].trim();
  }
  return null;
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

export interface GhStackRemotePullRequest {
  number: number;
  state: string;
  draft: boolean;
  mergedAt: string | null;
  head: {
    ref: string;
    sha: string;
  };
}

export interface GhStackRemoteStack {
  id: number;
  number: number;
  url: string;
  base: {
    ref: string;
  };
  open: boolean;
  pullRequests: GhStackRemotePullRequest[];
}

export type GhStackRemoteProbeResult =
  | { status: "found"; output: string; stack: GhStackRemoteStack }
  | { status: "absent"; output: string }
  | { status: "error"; output: string };

/** Arguments for the read-only public stack membership endpoint. */
export function stackRemoteMembershipArgs(
  owner: string,
  repository: string,
  pullRequest: number,
): string[] {
  if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) {
    throw new RangeError("pullRequest must be a positive integer");
  }
  return [
    "api",
    "--method",
    "GET",
    `repos/${owner}/${repository}/stacks?pull_request=${pullRequest}`,
  ];
}

/** Parse the successful JSON body returned by the public stacks endpoint. */
export function parseGhStackRemoteStacks(output: string): GhStackRemoteStack[] | null {
  try {
    const value = JSON.parse(output) as unknown;
    if (!Array.isArray(value)) return null;
    const stacks: GhStackRemoteStack[] = [];
    for (const entry of value) {
      const stack = parseGhStackRemoteStack(entry);
      if (!stack) return null;
      stacks.push(stack);
    }
    return stacks;
  } catch {
    return null;
  }
}

function parseGhStackRemoteStack(value: unknown): GhStackRemoteStack | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(object.id) ||
    (object.id as number) <= 0 ||
    !Number.isSafeInteger(object.number) ||
    (object.number as number) <= 0 ||
    typeof object.url !== "string" ||
    !object.url.trim() ||
    typeof object.open !== "boolean" ||
    !object.base ||
    typeof object.base !== "object" ||
    Array.isArray(object.base)
  ) {
    return null;
  }
  const base = object.base as Record<string, unknown>;
  if (typeof base.ref !== "string" || !base.ref.trim()) return null;
  if (!Array.isArray(object.pull_requests) || object.pull_requests.length === 0) return null;

  const pullRequests: GhStackRemotePullRequest[] = [];
  for (const value of object.pull_requests) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const pullRequest = value as Record<string, unknown>;
    const head = pullRequest.head;
    if (
      !Number.isSafeInteger(pullRequest.number) ||
      (pullRequest.number as number) <= 0 ||
      typeof pullRequest.state !== "string" ||
      !pullRequest.state.trim() ||
      typeof pullRequest.draft !== "boolean" ||
      !(pullRequest.merged_at === null || typeof pullRequest.merged_at === "string") ||
      !head ||
      typeof head !== "object" ||
      Array.isArray(head)
    ) {
      return null;
    }
    const headObject = head as Record<string, unknown>;
    if (
      typeof headObject.ref !== "string" ||
      !headObject.ref.trim() ||
      typeof headObject.sha !== "string" ||
      !headObject.sha.trim()
    ) {
      return null;
    }
    pullRequests.push({
      number: pullRequest.number as number,
      state: pullRequest.state.trim(),
      draft: pullRequest.draft,
      mergedAt: typeof pullRequest.merged_at === "string" ? pullRequest.merged_at : null,
      head: { ref: headObject.ref.trim(), sha: headObject.sha.trim() },
    });
  }

  return {
    id: object.id as number,
    number: object.number as number,
    url: object.url.trim(),
    base: { ref: base.ref.trim() },
    open: object.open,
    pullRequests,
  };
}

/**
 * Query remote stack membership without changing repository state. An empty
 * API array is authoritative absence; a successful body of any other shape
 * is an error rather than a false negative.
 */
export async function probeGhStackRemote(
  cwd: string,
  owner: string,
  repository: string,
  pullRequest: number,
  signal?: AbortSignal,
  runner: GhStackCommandRunner = runGhStackCommand,
): Promise<GhStackRemoteProbeResult> {
  try {
    const result = await runner(stackRemoteMembershipArgs(owner, repository, pullRequest), {
      cwd,
      signal,
    });
    const output = commandOutput(result);
    const stacks = parseGhStackRemoteStacks(result.stdout);
    if (!stacks) return { status: "error", output };
    if (stacks.length === 0) return { status: "absent", output };
    if (stacks.length > 1) return { status: "error", output };
    return { status: "found", output, stack: stacks[0] };
  } catch (error: unknown) {
    return { status: "error", output: errorOutput(error) };
  }
}

export type GhStackTargetResolution =
  | { status: "resolved"; branch: string }
  | { status: "ambiguous" | "invalid" | "nonmember"; reason: string };

function positiveSafeInteger(value: string): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function pullRequestNumberFromTarget(target: string): number | undefined {
  if (/^#[1-9][0-9]*$/.test(target)) return positiveSafeInteger(target.slice(1));
  if (/^[1-9][0-9]*$/.test(target)) return positiveSafeInteger(target);
  try {
    const url = new URL(target);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      target.includes("?") ||
      target.includes("#")
    ) {
      return undefined;
    }
    const match = url.pathname.match(/^\/[^/]+\/[^/]+\/pull\/([1-9][0-9]*)$/);
    return match ? positiveSafeInteger(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a user target strictly against the PRs present in a local view. */
export function resolveGhStackTarget(view: GhStackView, target: string): GhStackTargetResolution {
  const exactBranches = view.branches.filter((branch) => branch.name === target);
  if (exactBranches.length > 1) {
    return {
      status: "ambiguous",
      reason: `branch target matches multiple stack members: ${target}`,
    };
  }
  if (exactBranches.length === 1) {
    return { status: "resolved", branch: exactBranches[0].name };
  }

  const trimmed = target.trim();
  if (!trimmed) return { status: "invalid", reason: "target is empty" };
  const pullRequestNumber = pullRequestNumberFromTarget(trimmed);
  if (pullRequestNumber === undefined) {
    return { status: "invalid", reason: `invalid stack target: ${target}` };
  }

  const matches = view.branches.filter((branch) => branch.pr?.number === pullRequestNumber);
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reason: `pull request target matches multiple stack members: #${pullRequestNumber}`,
    };
  }
  if (matches.length === 0) {
    return { status: "nonmember", reason: `target is not a member of the local stack: ${target}` };
  }
  return { status: "resolved", branch: matches[0].name };
}
