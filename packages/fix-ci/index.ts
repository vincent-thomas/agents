/**
 * @vt-pi/fix-ci — a Pi extension factory that registers the
 * `push_and_check_ci` tool: pushes the current branch, opens a draft PR,
 * polls GitHub checks until they finish, returns results with failure logs,
 * and (on all-pass) marks the PR ready for review. Tracks fix cycles and
 * tells the agent to stop after MAX_CYCLES attempts.
 *
 * This is the package's only public entry point (see package.json's
 * "exports"): createFixCiExtension is its single export. The polling /
 * git / gh helpers in logic.ts are private implementation.
 *
 * Manual `git push` in bash is blocked by the command-policy extension
 * (its entries ban the "git push" subcommand), not here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Array as TArray, Object as TObject, Optional, String as TString } from "typebox";
import { currentBranch, isWorktreeDirty } from "./git-utils.ts";
import { cleanupBranchPoints, prepareBranchPoints } from "./branch-points.ts";
import {
  gitPush,
  gitPushToOrigin,
  gitPushBranchToOrigin,
  branchExistsOnOrigin,
  getHeadSha,
  resolveStackBranch,
  needsPush,
  pollChecks,
  fetchFailureLogs,
  isFailure,
  getPrBaseBranch,
  mergeBaseBranchIntoCurrent,
  needsPullBeforePush,
  pullRemoteChanges,
  isBaseBranchAhead,
  detectPrNumber,
  generatePrBody,
  generatePrTitle,
  createDraftPr,
  getPrState,
  markPrReady,
  addReviewers,
  getLatestChangesRequestedReviewer,
  getUnmergedPaths,
  type CheckResult,
  type FailureLog,
} from "./logic.ts";
import {
  probeGhStack,
  resolveGhStackTarget,
  runGhStackCheckout,
  runGhStackInit,
  runGhStackUnstack,
  runGhStackUnstackLocal,
  runGhStackSubmit,
  runGhStackLink,
  runGhStackSync,
  runGhStackCommand,
  isMiddleInsertionRejectionOutput,
  restoreWorkspaceBranch,
  type GhStackCommandRunner,
  type WorkspaceBranchRestorer,
} from "./github-stack.ts";
import {
  checkAndReadyStack,
  type StackReadinessResult,
  type StackReadinessRunner,
} from "./stack-readiness.ts";
import { inspectStackReport, inspectUnstackedStack } from "./stack-inspection.ts";
import {
  cleanupCheckout,
  restoreBranchSignalFree,
  verifyRefreshedStack,
} from "./stack-checkout.ts";
import { shellQuote } from "./shell-quote.ts";
import type {
  WorkspaceController,
  WorkspaceControllerClaim,
  WorkspaceControllerSnapshot,
} from "./stack-workspace.ts";
export type {
  WorkspaceController,
  WorkspaceControllerClaim,
  WorkspaceControllerSnapshot,
} from "./stack-workspace.ts";

const MAX_CYCLES = 5;

function isAlreadyStackedOutput(output: string): boolean {
  return (
    /current branch .*already (?:part of|in) (?:a )?stack/i.test(output) ||
    /already (?:part of|in) (?:a )?stack/i.test(output) ||
    /already belongs to (?:a )?stack/i.test(output)
  );
}

/** Shapes a tool result: single text block plus the machine-readable `details`
 * every branch below returns alongside it. */
function respond(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFixCiExtension(options: {
  assertWorkspace: (cwd: string) => Promise<void>;
  stackRunner?: GhStackCommandRunner;
  restoreBranch?: WorkspaceBranchRestorer;
  workspaceController?: WorkspaceController;
  stackReadinessRunner?: StackReadinessRunner;
}) {
  return function (pi: ExtensionAPI) {
    let cycleCount = 0;
    const stackRunner = options.stackRunner ?? runGhStackCommand;
    const restoreBranch = options.restoreBranch ?? restoreWorkspaceBranch;
    const stackReadinessRunner = options.stackReadinessRunner ?? checkAndReadyStack;

    const restoreOwnedBranch = async (cwd: string, originalBranch: string) => {
      // Restoration is safety cleanup and must still run after the caller
      // cancels the stack operation that moved the checkout.
      let current = await currentBranch(cwd);
      let clean = !(await isWorktreeDirty(cwd));
      let restoreOutput = "";

      if (current !== originalBranch && clean) {
        const restoration = await restoreBranch(cwd, originalBranch);
        restoreOutput = restoration.output;
        current = await currentBranch(cwd);
        clean = !(await isWorktreeDirty(cwd));
      }

      const restored = current === originalBranch && clean;
      if (restored) await options.assertWorkspace(cwd);
      return { restored, currentBranch: current, workingTreeClean: clean, restoreOutput };
    };

    /** Adopt a verified local stack into the host registry without changing the checkout. */
    const adoptStackOwnership = async (
      cwd: string,
      branches: readonly string[],
      baseBranch: string | null | undefined,
      activeBranch: string | null | undefined,
      signal: AbortSignal | undefined,
    ): Promise<{ success: boolean; details: Record<string, unknown> }> => {
      if (!options.workspaceController) {
        return { success: true, details: { workspaceOwnership: "unavailable" } };
      }

      const normalizedBranches = [...branches];
      const claim: WorkspaceControllerClaim = {
        branches: normalizedBranches,
        baseBranch: baseBranch?.trim() ?? "",
        activeBranch: activeBranch?.trim() ?? "",
      };
      const failure = (stage: string, error?: unknown, extra: Record<string, unknown> = {}) => ({
        success: false,
        details: {
          workspaceOwnership: "unavailable",
          workspaceOwnershipFailed: true,
          workspaceOwnershipFailure: {
            stage,
            ...(error === undefined ? {} : { error: errorMessage(error) }),
            claim,
            ...extra,
          },
        },
      });

      if (
        claim.branches.length === 0 ||
        !claim.baseBranch ||
        !claim.activeBranch ||
        !claim.branches.includes(claim.activeBranch)
      ) {
        return failure("invalid-claim", undefined, { reason: "exact-stack-metadata-required" });
      }

      let prior: WorkspaceControllerSnapshot;
      try {
        const snapshot = await options.workspaceController.snapshot(cwd);
        prior = { ...snapshot, branches: [...snapshot.branches] };
      } catch (error: unknown) {
        return failure("snapshot", error);
      }

      const unchanged =
        prior.activeBranch === claim.activeBranch &&
        prior.baseBranch === claim.baseBranch &&
        JSON.stringify(prior.branches) === JSON.stringify(claim.branches);

      try {
        await options.workspaceController.validate(cwd, claim);
      } catch (error: unknown) {
        return failure("validate", error, { priorSnapshot: prior });
      }

      if (signal?.aborted) {
        return failure("cancelled", undefined, { priorSnapshot: prior, cancelled: true });
      }

      const rollback = async (stage: string, error: unknown) => {
        try {
          await options.workspaceController!.restore(cwd, prior);
          const restored = await options.workspaceController!.snapshot(cwd);
          const verified =
            restored.activeBranch === prior.activeBranch &&
            restored.baseBranch === prior.baseBranch &&
            JSON.stringify(restored.branches) === JSON.stringify(prior.branches);
          return failure(stage, error, {
            priorSnapshot: prior,
            cancelled: signal?.aborted === true,
            rollback: {
              attempted: true,
              verified,
              snapshot: restored,
              ...(verified ? {} : { expected: prior }),
            },
          });
        } catch (rollbackError: unknown) {
          return failure(stage, error, {
            priorSnapshot: prior,
            cancelled: signal?.aborted === true,
            rollback: {
              attempted: true,
              verified: false,
              error: errorMessage(rollbackError),
            },
          });
        }
      };

      try {
        await options.workspaceController.claim(cwd, claim);
      } catch (error: unknown) {
        return rollback("claim", error);
      }

      try {
        await options.assertWorkspace(cwd);
      } catch (error: unknown) {
        return rollback("assertWorkspace", error);
      }

      return {
        success: true,
        details: {
          workspaceOwnership: unchanged ? "unchanged" : "adopted",
          workspaceOwnershipClaim: claim,
        },
      };
    };

    // ── Tool: create_github_stack ────────────────────────────────────────────
    pi.registerTool({
      name: "create_github_stack",
      label: "Create or Extend GitHub Stack",
      description:
        "Create or extend a GitHub CLI stack for the supplied branches. The working tree " +
        "must be clean and the workspace is restored to its original branch before " +
        "returning. Optionally provide `branch_points`, one commit-ish per branch " +
        "ordered base-to-tip; these materialize missing local branch refs without " +
        "switching checkout and require the final point to be HEAD. After this tool " +
        "succeeds, use push_and_check_ci to submit the stack and check every branch.",
      parameters: TObject({
        branches: TArray(TString(), {
          minItems: 1,
          description:
            "Local branch names ordered from the stack base to its tip. The final name must be the owned workspace branch when branch_points is provided.",
        }),
        base: Optional(
          TString({ description: "Optional GitHub base branch for the bottom PR in the stack." }),
        ),
        branch_points: Optional(
          TArray(TString(), {
            minItems: 1,
            description:
              "Commit-ish for each branch, ordered base-to-tip and ending at HEAD. Missing local branches are created at these points.",
          }),
        ),
      }),

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const cwd = ctx.cwd;
        await options.assertWorkspace(cwd);
        const branches =
          Array.isArray(params.branches) &&
          params.branches.every((branch: unknown): branch is string => typeof branch === "string")
            ? params.branches
            : [];
        const base = typeof params.base === "string" ? params.base : undefined;
        const rawBranchPoints = params.branch_points;
        const branchPointsSupplied = rawBranchPoints !== undefined;
        const branchPoints =
          Array.isArray(rawBranchPoints) &&
          rawBranchPoints.every((point: unknown): point is string => typeof point === "string")
            ? rawBranchPoints
            : null;

        if (
          branches.length === 0 ||
          branches.some((branch) => branch.trim().length === 0) ||
          (base !== undefined && base.trim().length === 0) ||
          (branchPointsSupplied &&
            (branchPoints === null ||
              branchPoints.length === 0 ||
              branchPoints.some((point) => point.trim().length === 0)))
        ) {
          return respond(
            "`branches` must contain at least one non-empty branch name; `base`, when provided, must be non-empty; `branch_points`, when provided, must contain non-empty commit points.",
            { invalidParameters: true },
          );
        }

        if (
          branchPointsSupplied &&
          branchPoints !== null &&
          branchPoints.length !== branches.length
        ) {
          return respond(
            "When provided, `branch_points` must contain exactly one commit point for each branch, ordered base-to-tip.",
            { invalidParameters: true, branches, branchPoints },
          );
        }
        const providedBranchPoints = branchPointsSupplied ? (branchPoints ?? []) : [];
        let materializedBranches: string[] = [];
        let materializedCommits: string[] = [];

        if (await isWorktreeDirty(cwd, signal)) {
          return respond(
            "The working tree must be clean before creating a GitHub stack. Commit or discard the pending changes, then call `create_github_stack` again.",
            { dirtyWorkingTree: true },
          );
        }

        const originalBranch = await currentBranch(cwd, signal);
        if (!originalBranch) {
          return respond("Could not determine the current branch; no GitHub stack was created.", {
            stackCreationFailed: true,
          });
        }
        if (branchPointsSupplied) {
          if (branches[branches.length - 1] !== originalBranch) {
            return respond(
              `When \`branch_points\` is supplied, the final branch must be the owned workspace branch \`${originalBranch}\`.`,
              {
                invalidParameters: true,
                currentBranch: originalBranch,
                branches,
                branchPoints: providedBranchPoints,
              },
            );
          }

          onUpdate?.({
            content: [{ type: "text", text: "Preparing GitHub stack branch points…" }],
          });
          const preparation = await prepareBranchPoints(
            cwd,
            branches,
            providedBranchPoints,
            originalBranch,
            signal,
          );
          materializedBranches = preparation.createdBranches;
          materializedCommits = preparation.commits ?? [];
          if (!preparation.success) {
            return respond(
              "GitHub stack preparation failed, so stack initialization was not run:\n\n" +
                `\`\`\`\n${preparation.output.trim()}\n\`\`\`\n\n` +
                "Any local branch refs created during preparation were rolled back. Fix the branch points and try again.",
              {
                stackCreationFailed: true,
                branchPointsPreparationFailed: true,
                stackInitializationRun: false,
                branches,
                branchPoints: providedBranchPoints,
                output: preparation.output,
              },
            );
          }
        } else if (!branches.includes(originalBranch)) {
          return respond(
            `The stack must include the owned workspace branch \`${originalBranch}\` so it can be submitted and checked without switching workspaces.`,
            {
              invalidParameters: true,
              currentBranch: originalBranch,
              branches,
            },
          );
        }

        onUpdate?.({ content: [{ type: "text", text: "Initializing GitHub stack…" }] });
        const init = await runGhStackInit(cwd, branches, base, signal, stackRunner);
        const rollback = async () => {
          if (!branchPointsSupplied || materializedBranches.length === 0) return "";

          // Git cannot cleanly delete the ref currently checked out. A stack
          // command can leave the checkout on a newly materialized branch, so
          // move back without asserting the workspace before deleting refs.
          const current = await currentBranch(cwd, undefined);
          let checkoutOutput = "";
          if (current && materializedBranches.includes(current) && current !== originalBranch) {
            const checkout = await restoreBranch(cwd, originalBranch, undefined);
            if (!checkout.success) checkoutOutput = checkout.output;
          }
          const rollbackOutput = await cleanupBranchPoints(
            cwd,
            branches,
            materializedCommits,
            materializedBranches,
          );
          return [checkoutOutput, rollbackOutput].filter(Boolean).join("\n");
        };

        // `gh stack init` refuses to operate on a branch already in a stack.
        // Only an explicit membership error followed by a successful probe is
        // treated as an extension; all other failures use the ordinary path.
        if (!init.success && isAlreadyStackedOutput(init.output)) {
          const probe = await probeGhStack(cwd, signal, stackRunner);
          if (probe.status === "stacked") {
            const previousBranches = probe.branches;
            const rollbackAndRestoreMismatch = async () => {
              const rollbackOutput = await rollback();
              const restoration = await restoreOwnedBranch(cwd, originalBranch);
              return { rollbackOutput, restoration };
            };
            if (!previousBranches.includes(originalBranch)) {
              const { rollbackOutput, restoration } = await rollbackAndRestoreMismatch();
              return respond(
                `GitHub stack inspection did not include the owned branch \`${originalBranch}\`, so the existing stack was left untouched.`,
                {
                  stackExtensionFailed: true,
                  stackCreationFailed: true,
                  stackProbeMismatch: true,
                  previousStackRestored: true,
                  workspaceRestored: restoration.restored,
                  rollbackOutput,
                  operationOutputs: { initialInit: init.output, stackProbe: probe.output },
                  previousBranches,
                  previousBase: probe.baseBranch,
                  requestedBranches: branches,
                  currentBranch: restoration.currentBranch,
                  restoreOutput: restoration.restoreOutput,
                },
              );
            }
            let requestedIndex = 0;
            const previousBranchesFit = previousBranches.every((branch) => {
              while (requestedIndex < branches.length && branches[requestedIndex] !== branch) {
                requestedIndex++;
              }
              if (requestedIndex === branches.length) return false;
              requestedIndex++;
              return true;
            });
            const restoreAndRollback = async () => {
              // Remove refs created by this invocation before asserting the
              // workspace. Ref cleanup must happen even when restoration or
              // the workspace assertion fails.
              const rollbackOutput = await rollback();
              const restoration = await restoreOwnedBranch(cwd, originalBranch);
              return { restoration, rollbackOutput };
            };
            const previousBase = probe.baseBranch;
            const replacementBase = previousBase ?? undefined;
            const recoverPreviousStack = async () => {
              // Recovery deliberately ignores the caller's signal. A failed
              // unstack may already have removed local state, so always run
              // cleanup, re-init, restore the owned checkout, and then run an
              // independent verification probe.
              const cleanupUnstack = await runGhStackUnstackLocal(cwd, undefined, stackRunner);
              const previousInit = await runGhStackInit(
                cwd,
                previousBranches,
                replacementBase,
                undefined,
                stackRunner,
              );
              const checkoutRestoration = await restoreBranch(cwd, originalBranch, undefined);
              const verification = await probeGhStack(cwd, undefined, stackRunner);
              const branchesMatch =
                verification.status === "stacked" &&
                verification.branches.length === previousBranches.length &&
                verification.branches.every((branch, index) => branch === previousBranches[index]);
              const baseMatches = previousBase !== null && verification.baseBranch === previousBase;
              return {
                previousStackRestored:
                  previousInit.success &&
                  checkoutRestoration.success &&
                  branchesMatch &&
                  baseMatches,
                previousInitSuccess: previousInit.success,
                checkoutRestored: checkoutRestoration.success,
                checkoutRestoreOutput: checkoutRestoration.output,
                cleanupOutput: cleanupUnstack.output,
                previousInitOutput: previousInit.output,
                verificationOutput: verification.output,
                verificationStatus: verification.status,
                verificationBranches: verification.branches,
                verificationBase: verification.baseBranch,
                branchesMatch,
                baseMatches,
              };
            };
            const operationOutputs = { initialInit: init.output, stackProbe: probe.output };

            const requestedBaseDiffers =
              base !== undefined && previousBase !== null && base !== previousBase;
            if (requestedBaseDiffers) {
              const { restoration, rollbackOutput } = await restoreAndRollback();
              return respond(
                `The existing GitHub stack has base \`${previousBase}\`, but the requested base is \`${base}\`. The existing stack was left in place.`,
                {
                  stackExtensionFailed: true,
                  stackCreationFailed: true,
                  previousStackRestored: true,
                  workspaceRestored: restoration.restored,
                  rollbackOutput,
                  operationOutputs,
                  previousBranches,
                  previousBase,
                  requestedBranches: branches,
                  requestedBase: base,
                  currentBranch: restoration.currentBranch,
                  restoreOutput: restoration.restoreOutput,
                },
              );
            }

            if (!previousBranchesFit) {
              const { restoration, rollbackOutput } = await restoreAndRollback();
              return respond(
                `Cannot extend the existing GitHub stack without changing its order. Existing branches are ${previousBranches.map((branch) => `\`${branch}\``).join(", ")}; requested branches must contain them in the same order. The existing stack was left in place.`,
                {
                  stackExtensionFailed: true,
                  stackCreationFailed: true,
                  previousStackRestored: true,
                  workspaceRestored: restoration.restored,
                  rollbackOutput,
                  operationOutputs,
                  previousBranches,
                  previousBase,
                  requestedBranches: branches,
                  currentBranch: restoration.currentBranch,
                  restoreOutput: restoration.restoreOutput,
                },
              );
            }

            const sameBranches =
              previousBranches.length === branches.length &&
              previousBranches.every((branch, index) => branch === branches[index]);
            if (previousBase === null && (!sameBranches || base !== undefined)) {
              const { restoration, rollbackOutput } = await restoreAndRollback();
              return respond(
                "The existing GitHub stack did not identify its base branch, so it cannot be extended safely. An explicit base cannot substitute for the unknown existing base; the existing stack was left in place.",
                {
                  stackExtensionFailed: true,
                  stackCreationFailed: true,
                  previousStackRestored: true,
                  existingBaseUnknown: true,
                  workspaceRestored: restoration.restored,
                  rollbackOutput,
                  operationOutputs,
                  previousBranches,
                  previousBase,
                  requestedBranches: branches,
                  ...(base !== undefined ? { requestedBase: base } : {}),
                  currentBranch: restoration.currentBranch,
                  restoreOutput: restoration.restoreOutput,
                },
              );
            }
            if (sameBranches) {
              const restoration = await restoreOwnedBranch(cwd, originalBranch);
              if (!restoration.restored) {
                const rollbackOutput = await rollback();
                return respond(
                  "The existing GitHub stack was found, but the owned workspace branch could not be restored safely. Stop and inspect the workspace manually.",
                  {
                    stackExtensionFailed: true,
                    stackCreationFailed: true,
                    previousStackRestored: true,
                    workspaceRestored: false,
                    rollbackOutput,
                    operationOutputs,
                    previousBranches,
                    previousBase,
                    requestedBranches: branches,
                    currentBranch: restoration.currentBranch,
                    restoreOutput: restoration.restoreOutput,
                  },
                );
              }
              let adoptionBase = replacementBase ?? null;
              let adoptionProbeOutput: string | undefined;
              if (options.workspaceController && !adoptionBase) {
                // The first view may be an older CLI shape without a base. A
                // signal-free refresh is required before persisting ownership.
                const adoptionProbe = await probeGhStack(cwd, undefined, stackRunner);
                adoptionProbeOutput = adoptionProbe.output;
                const exact =
                  adoptionProbe.status === "stacked" &&
                  adoptionProbe.branches.length === branches.length &&
                  adoptionProbe.branches.every((branch, index) => branch === branches[index]) &&
                  adoptionProbe.branches.includes(originalBranch) &&
                  (!adoptionProbe.view ||
                    (adoptionProbe.view.currentBranch === originalBranch &&
                      adoptionProbe.view.branches.filter((branch) => branch.isCurrent).length ===
                        1 &&
                      adoptionProbe.view.branches.some(
                        (branch) => branch.isCurrent && branch.name === originalBranch,
                      ))) &&
                  Boolean(adoptionProbe.baseBranch?.trim());
                if (!exact) {
                  const rollbackOutput = await rollback();
                  return respond(
                    "The local GitHub stack exists, but its base could not be verified for workspace ownership adoption. The existing stack was left in place.",
                    {
                      stackExtensionFailed: true,
                      stackCreationFailed: true,
                      workspaceOwnershipFailed: true,
                      workspaceOwnership: "unavailable",
                      workspaceOwnershipFailure: {
                        stage: "probe",
                        reason: "exact-stack-metadata-required",
                        probeOutput: adoptionProbe.output,
                        branches: adoptionProbe.branches,
                        baseBranch: adoptionProbe.baseBranch,
                      },
                      previousStackRestored: true,
                      workspaceRestored: true,
                      rollbackOutput,
                      previousBranches,
                      previousBase,
                      requestedBranches: branches,
                      currentBranch: originalBranch,
                      ...(branchPointsSupplied
                        ? { branchPoints: providedBranchPoints, materializedBranches }
                        : {}),
                    },
                  );
                }
                adoptionBase = adoptionProbe.baseBranch!.trim();
              }
              const ownership = await adoptStackOwnership(
                cwd,
                branches,
                adoptionBase,
                originalBranch,
                signal,
              );
              if (!ownership.success) {
                const rollbackOutput = await rollback();
                return respond(
                  "The local GitHub stack exists, but workspace ownership adoption failed. The stack was not reported as created; fix the workspace ownership issue and try again.",
                  {
                    stackExtensionFailed: true,
                    stackCreationFailed: true,
                    previousStackRestored: true,
                    workspaceRestored: true,
                    rollbackOutput,
                    previousBranches,
                    previousBase,
                    requestedBranches: branches,
                    branches,
                    base: adoptionBase,
                    adoptionProbeOutput,
                    ...ownership.details,
                    ...(branchPointsSupplied
                      ? {
                          branchPoints: providedBranchPoints,
                          materializedBranches,
                          resolvedCommits: materializedCommits,
                        }
                      : {}),
                  },
                );
              }
              return respond(
                `GitHub stack already exists for ${branches.map((branch) => `\`${branch}\``).join(", ")}. The workspace was restored. Call \`push_and_check_ci\` to submit and check CI.`,
                {
                  stackCreated: true,
                  stackExtended: true,
                  previousStackRestored: true,
                  workspaceRestored: true,
                  previousBranches,
                  previousBase,
                  requestedBranches: branches,
                  branches,
                  base: adoptionBase,
                  adoptionProbeOutput,
                  ...ownership.details,
                  ...(branchPointsSupplied
                    ? {
                        branchPoints: providedBranchPoints,
                        materializedBranches,
                        resolvedCommits: materializedCommits,
                      }
                    : {}),
                },
              );
            }

            onUpdate?.({
              content: [{ type: "text", text: "Replacing the existing GitHub stack…" }],
            });
            const unstack = await runGhStackUnstackLocal(cwd, signal, stackRunner);
            if (!unstack.success) {
              const recovery = await recoverPreviousStack();
              const { restoration, rollbackOutput } = await restoreAndRollback();
              return respond(
                `The existing GitHub stack could not be unstacked locally. ${recovery.previousStackRestored ? "The previous stack was verified and restored." : "The previous stack could not be verified as restored; stop and inspect the workspace manually."} The workspace was restored as far as safely possible.\n\nUnstack output:\n\`\`\`\n${unstack.output.trim()}\n\`\`\``,
                {
                  stackExtensionFailed: true,
                  stackCreationFailed: true,
                  previousStackRestored: recovery.previousStackRestored,
                  previousStackCheckoutRestored: recovery.checkoutRestored,
                  previousStackBranchesMatch: recovery.branchesMatch,
                  previousStackBaseMatch: recovery.baseMatches,
                  previousStackInitSuccess: recovery.previousInitSuccess,
                  previousInitSuccess: recovery.previousInitSuccess,
                  workspaceRestored: restoration.restored,
                  rollbackOutput,
                  operationOutputs: {
                    ...operationOutputs,
                    unstack: unstack.output,
                    cleanupUnstack: recovery.cleanupOutput,
                    previousStackInit: recovery.previousInitOutput,
                    previousStackInitSuccess: recovery.previousInitSuccess,
                    previousInitSuccess: recovery.previousInitSuccess,
                    previousStackRestore: recovery.checkoutRestoreOutput,
                    previousStackRestoreSuccess: recovery.checkoutRestored,
                    previousStackProbe: recovery.verificationOutput,
                  },
                  previousBranches,
                  previousBase,
                  requestedBranches: branches,
                  currentBranch: restoration.currentBranch,
                  restoreOutput: restoration.restoreOutput,
                },
              );
            }

            const replacement = await runGhStackInit(
              cwd,
              branches,
              replacementBase,
              signal,
              stackRunner,
            );
            if (!replacement.success) {
              const recovery = await recoverPreviousStack();
              const { restoration, rollbackOutput } = await restoreAndRollback();
              return respond(
                `GitHub stack extension failed. ${recovery.previousStackRestored ? "The previous stack was restored." : "The previous stack could not be restored; stop and inspect the workspace manually."} ${restoration.restored ? "The workspace was restored." : "The workspace could not be restored; stop and inspect it manually."}`,
                {
                  stackExtensionFailed: true,
                  stackCreationFailed: true,
                  previousStackRestored: recovery.previousStackRestored,
                  previousStackCheckoutRestored: recovery.checkoutRestored,
                  previousStackBranchesMatch: recovery.branchesMatch,
                  previousStackBaseMatch: recovery.baseMatches,
                  previousStackInitSuccess: recovery.previousInitSuccess,
                  previousInitSuccess: recovery.previousInitSuccess,
                  workspaceRestored: restoration.restored,
                  rollbackOutput,
                  operationOutputs: {
                    ...operationOutputs,
                    unstack: unstack.output,
                    replacementInit: replacement.output,
                    cleanupUnstack: recovery.cleanupOutput,
                    previousStackInit: recovery.previousInitOutput,
                    previousStackInitSuccess: recovery.previousInitSuccess,
                    previousInitSuccess: recovery.previousInitSuccess,
                    previousStackRestore: recovery.checkoutRestoreOutput,
                    previousStackRestoreSuccess: recovery.checkoutRestored,
                    previousStackProbe: recovery.verificationOutput,
                  },
                  previousBranches,
                  previousBase,
                  requestedBranches: branches,
                  currentBranch: restoration.currentBranch,
                  restoreOutput: restoration.restoreOutput,
                },
              );
            }

            const replacementRestoration = await restoreOwnedBranch(cwd, originalBranch);
            const replacementProbe = await probeGhStack(cwd, undefined, stackRunner);
            const replacementBranchesMatch =
              replacementProbe.status === "stacked" &&
              replacementProbe.branches.length === branches.length &&
              replacementProbe.branches.every((branch, index) => branch === branches[index]);
            const replacementBaseMatch =
              replacementBase !== undefined && replacementProbe.baseBranch === replacementBase;
            const replacementVerified = replacementBranchesMatch && replacementBaseMatch;
            const replacementOutputs = {
              ...operationOutputs,
              unstack: unstack.output,
              replacementInit: replacement.output,
              replacementCheckout: replacementRestoration.restoreOutput,
              replacementStackProbe: replacementProbe.output,
            };

            if (!replacementRestoration.restored || !replacementVerified) {
              const recovery = await recoverPreviousStack();
              const { restoration, rollbackOutput } = await restoreAndRollback();
              return respond(
                `GitHub stack extension could not be verified after replacement initialization. ${recovery.previousStackRestored ? "The previous stack was restored." : "The previous stack could not be restored; stop and inspect the workspace manually."} ${restoration.restored ? "The workspace was restored." : "The workspace could not be restored; stop and inspect it manually."}`,
                {
                  stackExtensionFailed: true,
                  stackCreationFailed: true,
                  previousStackRestored: recovery.previousStackRestored,
                  previousStackCheckoutRestored: recovery.checkoutRestored,
                  previousStackBranchesMatch: recovery.branchesMatch,
                  previousStackBaseMatch: recovery.baseMatches,
                  previousStackInitSuccess: recovery.previousInitSuccess,
                  previousInitSuccess: recovery.previousInitSuccess,
                  workspaceRestored: restoration.restored,
                  rollbackOutput,
                  operationOutputs: {
                    ...replacementOutputs,
                    cleanupUnstack: recovery.cleanupOutput,
                    previousStackInit: recovery.previousInitOutput,
                    previousStackInitSuccess: recovery.previousInitSuccess,
                    previousInitSuccess: recovery.previousInitSuccess,
                    previousStackRestore: recovery.checkoutRestoreOutput,
                    previousStackRestoreSuccess: recovery.checkoutRestored,
                    previousStackProbe: recovery.verificationOutput,
                  },
                  replacementVerified,
                  replacementCheckoutRestored: replacementRestoration.restored,
                  replacementBranchesMatch,
                  replacementBaseMatch,
                  replacementProbeStatus: replacementProbe.status,
                  replacementBranches: replacementProbe.branches,
                  replacementBase: replacementProbe.baseBranch,
                  previousBranches,
                  previousBase,
                  requestedBranches: branches,
                  currentBranch: restoration.currentBranch,
                  restoreOutput: restoration.restoreOutput,
                },
              );
            }

            const ownership = await adoptStackOwnership(
              cwd,
              branches,
              replacementBase,
              originalBranch,
              signal,
            );
            if (!ownership.success) {
              return respond(
                "The local GitHub stack exists, but workspace ownership adoption failed. The stack and its branch refs were preserved for inspection; fix the workspace ownership issue and try again.",
                {
                  stackExtensionFailed: true,
                  stackCreationFailed: true,
                  workspaceRestored: true,
                  replacementVerified: true,
                  replacementBranchesMatch: true,
                  replacementBaseMatch: true,
                  replacementStackProbe: replacementProbe.output,
                  previousBranches,
                  previousBase,
                  requestedBranches: branches,
                  branches,
                  base: replacementBase,
                  ...ownership.details,
                  ...(branchPointsSupplied
                    ? {
                        branchPoints: providedBranchPoints,
                        materializedBranches,
                        resolvedCommits: materializedCommits,
                      }
                    : {}),
                },
              );
            }
            return respond(
              `GitHub stack extended from ${previousBranches.map((branch) => `\`${branch}\``).join(", ")} to ${branches.map((branch) => `\`${branch}\``).join(", ")}${replacementBase ? ` on base \`${replacementBase}\`` : ""}.` +
                (branchPointsSupplied
                  ? ` Prepared ${providedBranchPoints.length} branch point${providedBranchPoints.length === 1 ? "" : "s"} without switching checkout.`
                  : "") +
                " The workspace was restored. Call `push_and_check_ci` to submit and check CI.",
              {
                stackCreated: true,
                stackExtended: true,
                workspaceRestored: true,
                replacementVerified: true,
                replacementBranchesMatch: true,
                replacementBaseMatch: true,
                replacementStackProbe: replacementProbe.output,
                previousBranches,
                previousBase,
                requestedBranches: branches,
                branches,
                base: replacementBase,
                ...ownership.details,
                ...(branchPointsSupplied
                  ? {
                      branchPoints: providedBranchPoints,
                      materializedBranches,
                      resolvedCommits: materializedCommits,
                    }
                  : {}),
              },
            );
          }
        }

        // A failed ordinary init may still have materialized branch refs before
        // returning (including after a cancellation). Remove them before any
        // restoration or workspace assertion.
        const rollbackOutput = init.success ? "" : await rollback();
        const restoration = await restoreOwnedBranch(cwd, originalBranch);

        if (!restoration.restored) {
          return respond(
            `GitHub stack initialization completed${init.success ? "" : " with an error"}, but the workspace was not restored to its original state. ` +
              `It started on \`${originalBranch}\` and is now on \`${restoration.currentBranch ?? "no branch"}\`${restoration.workingTreeClean ? "" : " with uncommitted changes"}. ` +
              (!init.success
                ? `Any local branch refs created during this invocation were rolled back.${rollbackOutput ? ` Rollback output:\n\`\`\`\n${rollbackOutput.trim()}\n\`\`\`` : ""} `
                : "") +
              "Stop and inspect the workspace manually.",
            {
              stackCreationFailed: !init.success,
              workspaceRestored: false,
              originalBranch,
              currentBranch: restoration.currentBranch,
              workingTreeClean: restoration.workingTreeClean,
              output: init.output,
              rollbackOutput,
              restoreOutput: restoration.restoreOutput,
            },
          );
        }

        if (!init.success) {
          return respond(
            `GitHub stack initialization failed:\n\n\`\`\`\n${init.output.trim()}\n\`\`\`\n\nAny local branch refs created during this invocation were rolled back.${rollbackOutput ? `\n\nRollback output:\n\`\`\`\n${rollbackOutput.trim()}\n\`\`\`` : ""}\n\nFix the error and try again.`,
            {
              stackCreationFailed: true,
              workspaceRestored: true,
              output: init.output,
              rollbackOutput,
            },
          );
        }

        let adoptionBase = base ?? null;
        let adoptionProbeOutput: string | undefined;
        if (options.workspaceController && !adoptionBase) {
          // `gh stack init` can succeed while the older view format omits the
          // base. Do not persist an ownership record until a fresh exact view
          // supplies both the requested members and a base.
          const adoptionProbe = await probeGhStack(cwd, undefined, stackRunner);
          adoptionProbeOutput = adoptionProbe.output;
          const exact =
            adoptionProbe.status === "stacked" &&
            adoptionProbe.branches.length === branches.length &&
            adoptionProbe.branches.every((branch, index) => branch === branches[index]) &&
            adoptionProbe.branches.includes(originalBranch) &&
            (!adoptionProbe.view ||
              (adoptionProbe.view.currentBranch === originalBranch &&
                adoptionProbe.view.branches.filter((branch) => branch.isCurrent).length === 1 &&
                adoptionProbe.view.branches.some(
                  (branch) => branch.isCurrent && branch.name === originalBranch,
                ))) &&
            Boolean(adoptionProbe.baseBranch?.trim());
          if (!exact) {
            return respond(
              "The local GitHub stack exists, but its base could not be verified for workspace ownership adoption. The stack and its branch refs were preserved for inspection.",
              {
                stackCreationFailed: true,
                workspaceRestored: true,
                workspaceOwnershipFailed: true,
                workspaceOwnership: "unavailable",
                workspaceOwnershipFailure: {
                  stage: "probe",
                  reason: "exact-stack-metadata-required",
                  probeOutput: adoptionProbe.output,
                  branches: adoptionProbe.branches,
                  baseBranch: adoptionProbe.baseBranch,
                },
                branches,
                base: null,
                adoptionProbeOutput,
              },
            );
          }
          adoptionBase = adoptionProbe.baseBranch!.trim();
        }
        const ownership = await adoptStackOwnership(
          cwd,
          branches,
          adoptionBase,
          originalBranch,
          signal,
        );
        if (!ownership.success) {
          return respond(
            "The local GitHub stack exists, but workspace ownership adoption failed. The stack and its branch refs were preserved for inspection; fix the workspace ownership issue and try again.",
            {
              stackCreationFailed: true,
              workspaceRestored: true,
              branches,
              base: adoptionBase,
              adoptionProbeOutput,
              ...ownership.details,
              ...(branchPointsSupplied
                ? { branchPoints: providedBranchPoints, materializedBranches }
                : {}),
            },
          );
        }
        const materialized = branchPointsSupplied
          ? ` Prepared ${providedBranchPoints.length} branch point${providedBranchPoints.length === 1 ? "" : "s"} without switching checkout.`
          : "";
        return respond(
          `GitHub stack created for ${branches.map((branch) => `\`${branch}\``).join(", ")}${adoptionBase ? ` on base \`${adoptionBase}\`` : ""}.` +
            materialized +
            " The workspace was restored. Call `push_and_check_ci` to submit and check CI.",
          {
            stackCreated: true,
            workspaceRestored: true,
            branches,
            base: adoptionBase,
            adoptionProbeOutput,
            ...ownership.details,
            ...(branchPointsSupplied
              ? { branchPoints: providedBranchPoints, materializedBranches }
              : {}),
          },
        );
      },
    });

    // ── Tool: inspect_stack ─────────────────────────────────────────────────
    pi.registerTool({
      name: "inspect_stack",
      label: "Inspect GitHub Stack",
      description:
        "Semantic read-only inspection of the local GitHub stack, authoritative remote stack membership, " +
        "and host workspace ownership. It does not switch branches, push, or mutate remote membership. " +
        "Reports which descendants a commit on the active branch will restack.",
      parameters: TObject({}),

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const cwd = ctx.cwd;
        await options.assertWorkspace(cwd);
        const probe = await probeGhStack(cwd, signal, stackRunner);
        if (probe.status === "unstacked") {
          const remoteFallback = await inspectUnstackedStack(
            cwd,
            signal,
            stackRunner,
            options.workspaceController,
          );
          if (remoteFallback.status === "found") {
            return respond(remoteFallback.report.text, remoteFallback.report.details);
          }
          if (remoteFallback.status === "unavailable") {
            return respond(
              "The local GitHub stack metadata says unstacked, and authoritative remote stack membership could not be determined. Inspection did not switch branches, push, or mutate remote membership.",
              {
                status: "partial",
                local: { status: "unstacked", output: probe.output },
                remote: { status: "unavailable", output: remoteFallback.output },
              },
            );
          }
          return respond(
            "The current branch is not part of a GitHub stack. Inspection did not switch branches, push, or mutate remote membership.",
            {
              status: "unstacked",
              local: { status: "unstacked", output: probe.output },
              remote: { status: "absent", output: remoteFallback.output },
            },
          );
        }
        if (probe.status !== "stacked" || !probe.view) {
          return respond(
            "The GitHub stack view was malformed or incomplete. Inspection did not switch branches, push, or mutate remote membership.",
            {
              status: "malformed",
              local: { status: "malformed", output: probe.output, branches: probe.branches },
              remote: { status: "unavailable" },
            },
          );
        }

        const report = await inspectStackReport(
          cwd,
          probe.view,
          signal,
          stackRunner,
          options.workspaceController,
        );
        return respond(report.text, report.details);
      },
    });

    // ── Tool: checkout_stack_branch ─────────────────────────────────────────
    pi.registerTool({
      name: "checkout_stack_branch",
      label: "Checkout GitHub Stack Branch",
      description:
        "Switch to another member of the current local GitHub stack, adopting the complete stack " +
        "only after the checkout is verified. The working tree must be clean.",
      parameters: TObject({
        target: TString({ description: "Stack branch name, PR number, #PR, or PR URL." }),
      }),

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const cwd = ctx.cwd;
        await options.assertWorkspace(cwd);
        if (!options.workspaceController) {
          return respond(
            "Stack branch checkout is unavailable because no workspace controller was injected.",
            { unavailable: true, reason: "workspace-controller-missing" },
          );
        }
        const target = typeof params.target === "string" ? params.target : "";
        if (await isWorktreeDirty(cwd, signal)) {
          return respond(
            "The working tree must be clean before checking out a stack branch. No state was changed.",
            { dirtyWorkingTree: true, rollback: "not-needed" },
          );
        }
        const originalBranch = await currentBranch(cwd, signal);
        if (!originalBranch) {
          return respond("Could not determine the current branch; no checkout was attempted.", {
            unavailable: true,
            reason: "current-branch-unknown",
          });
        }
        const probe = await probeGhStack(cwd, signal, stackRunner);
        if (probe.status !== "stacked" || !probe.view) {
          return respond(
            probe.status === "unstacked"
              ? "The current branch is not part of a complete local GitHub stack; no checkout was attempted."
              : "The local GitHub stack view was malformed or unavailable; no checkout was attempted.",
            { checkoutFailed: true, localStatus: probe.status, output: probe.output },
          );
        }
        const resolution = resolveGhStackTarget(probe.view, target);
        if (resolution.status !== "resolved") {
          return respond(`Cannot checkout stack target: ${resolution.reason}.`, {
            invalidTarget: true,
            target,
            resolution,
            branches: probe.view.branches.map((branch) => branch.name),
          });
        }
        const baseBranch = probe.view.trunk ?? probe.view.base;
        if (!baseBranch) {
          return respond(
            "The local GitHub stack view does not identify a base branch; no checkout or workspace ownership validation was attempted.",
            {
              checkoutFailed: true,
              invalidStackMetadata: true,
              baseBranch: null,
              validationAttempted: false,
            },
          );
        }
        const claim = {
          baseBranch,
          branches: probe.view.branches.map((branch) => branch.name),
          activeBranch: resolution.branch,
        } satisfies WorkspaceControllerClaim;
        let originalSnapshot: WorkspaceControllerSnapshot;
        try {
          // Capture ownership before validation so every post-claim failure can
          // restore the exact durable state that preceded this checkout.
          const snapshot = await options.workspaceController.snapshot(cwd);
          // Keep an immutable caller-owned copy in case the host reuses its
          // returned arrays while applying a claim.
          originalSnapshot = { ...snapshot, branches: [...snapshot.branches] };
        } catch (error: unknown) {
          return respond(
            "Could not snapshot workspace ownership; no checkout or validation was attempted.",
            {
              unavailable: true,
              reason: "workspace-snapshot-failed",
              error: errorMessage(error),
              claim,
            },
          );
        }

        try {
          await options.workspaceController.validate(cwd, claim);
        } catch (error: unknown) {
          if (signal?.aborted) {
            const rollback = await cleanupCheckout(
              cwd,
              originalBranch,
              originalSnapshot,
              restoreBranch,
              options.workspaceController,
            );
            return respond(`Checkout cancelled during workspace validation. ${rollback.text}`, {
              cancelled: true,
              validationFailed: true,
              claim,
              ...rollback.details,
            });
          }
          return respond(
            `Workspace ownership validation rejected stack branch \`${resolution.branch}\`; no checkout was attempted.`,
            { ownership: "mismatch", validationFailed: true, error: errorMessage(error), claim },
          );
        }

        let checkoutOutput = "";
        let checkoutAttempted = false;
        if (originalBranch !== resolution.branch) {
          checkoutAttempted = true;
          const checkout = await runGhStackCheckout(cwd, resolution.branch, signal, stackRunner);
          checkoutOutput = checkout.output;
          if (!checkout.success || signal?.aborted) {
            const rollback = await restoreBranchSignalFree(cwd, originalBranch, restoreBranch);
            return respond(`GitHub stack checkout failed. ${rollback.text}`, {
              checkoutFailed: true,
              checkoutAttempted,
              cancelled: signal?.aborted === true,
              output: checkout.output,
              ...rollback.details,
            });
          }
        }

        const actualBranch = await currentBranch(cwd);
        const refreshed = await probeGhStack(cwd, undefined, stackRunner);
        const verified = await verifyRefreshedStack(
          actualBranch,
          refreshed,
          claim,
          async () => !(await isWorktreeDirty(cwd)),
        );
        if (!verified) {
          const rollback = await restoreBranchSignalFree(cwd, originalBranch, restoreBranch);
          return respond(
            `The checkout could not be verified; no workspace ownership was claimed. ${rollback.text}`,
            {
              checkoutFailed: true,
              verificationFailed: true,
              checkoutAttempted,
              checkoutOutput,
              actualBranch,
              refreshedStatus: refreshed.status,
              ...rollback.details,
            },
          );
        }

        if (signal?.aborted) {
          const rollback = await cleanupCheckout(
            cwd,
            originalBranch,
            originalSnapshot,
            restoreBranch,
            options.workspaceController,
          );
          return respond(
            `Checkout cancelled before workspace ownership was claimed. ${rollback.text}`,
            {
              cancelled: true,
              checkoutAttempted,
              checkoutOutput,
              ...rollback.details,
            },
          );
        }

        try {
          await options.workspaceController.claim(cwd, claim);
        } catch (error: unknown) {
          const rollback = await cleanupCheckout(
            cwd,
            originalBranch,
            originalSnapshot,
            restoreBranch,
            options.workspaceController,
          );
          return respond(
            `Workspace ownership claim failed after checkout. ${rollback.text} The registry was restored only if verification succeeded.`,
            {
              checkoutFailed: true,
              claimFailed: true,
              checkoutAttempted,
              checkoutOutput,
              error: errorMessage(error),
              ...rollback.details,
            },
          );
        }
        try {
          await options.assertWorkspace(cwd);
        } catch (error: unknown) {
          const rollback = await cleanupCheckout(
            cwd,
            originalBranch,
            originalSnapshot,
            restoreBranch,
            options.workspaceController,
          );
          return respond(
            `Workspace verification failed after the ownership claim. ${rollback.text}`,
            {
              checkoutFailed: true,
              assertWorkspaceFailed: true,
              claimSucceeded: true,
              checkoutAttempted,
              checkoutOutput,
              error: errorMessage(error),
              ...rollback.details,
            },
          );
        }
        const descendants = claim.branches.slice(claim.branches.indexOf(claim.activeBranch) + 1);
        return respond(
          checkoutAttempted
            ? `Checked out \`${claim.activeBranch}\` in the GitHub stack. A future commit/push on this branch will restack descendants: ${descendants.length > 0 ? descendants.map((branch) => `\`${branch}\``).join(", ") : "none"}.`
            : `Already on \`${claim.activeBranch}\`; workspace ownership was adopted for the GitHub stack. A future commit/push will restack descendants: ${descendants.length > 0 ? descendants.map((branch) => `\`${branch}\``).join(", ") : "none"}.`,
          {
            checkoutSucceeded: true,
            checkoutAttempted,
            activeBranch: claim.activeBranch,
            branches: claim.branches,
            baseBranch: claim.baseBranch,
            descendants,
            checkoutOutput,
            ownership: "synchronized",
          },
        );
      },
    });

    // ── Tool: push_and_check_ci ─────────────────────────────────────────────
    pi.registerTool({
      name: "push_and_check_ci",
      label: "Push & Check CI",
      description:
        "Push the current branch to origin, create a draft PR if none exists, " +
        "poll GitHub Actions checks until they all finish, and if all pass " +
        "mark the PR as ready for review. For a GitHub stack, resolves every " +
        "stack branch to its exact local SHA, checks every branch, and marks " +
        "draft PRs ready only after all checks pass. " +
        "Returns the status of every check. For failures, includes " +
        "the last 200 lines of log output. " +
        "You MUST use this tool instead of running `git push` in bash. " +
        "After fixing failures (local or CI), call this tool again.",
      parameters: TObject({}),

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const cwd = ctx.cwd;
        await options.assertWorkspace(cwd);
        const notify = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

        // ── 0. Reject if working tree is dirty ─────────────────────────
        notify("Checking for uncommitted changes…");

        if (await isWorktreeDirty(cwd, signal)) {
          return respond(
            `## ⚠️ Working Tree Has Uncommitted Changes\n\n` +
              `The working tree is dirty — there are unstaged, uncommitted changes.\n\n` +
              `Commit them first before pushing. A push should represent a clear, ` +
              `verifiable checkpoint.\n\n` +
              `Run \`git status\` to see what's pending, then stage and commit. ` +
              `After committing, call \`push_and_check_ci\` again.`,
            { dirtyWorkingTree: true },
          );
        }

        // ── 1. Detect a GitHub stack before ordinary push synchronization ──
        // `gh stack sync` owns rebasing a stack. Do not run the ordinary
        // merge/pull path afterward: that would undo stack semantics.
        const branchName = await currentBranch(cwd, signal);
        const stackProbe = await probeGhStack(cwd, signal, stackRunner);
        let pushedSha: string | undefined;
        let prBase: string | null = null;

        if (stackProbe.status === "error") {
          return respond(
            `Could not determine whether the current branch belongs to a GitHub stack. ` +
              `The ordinary push workflow was not started because that could corrupt stack history.\n\n` +
              `### gh stack view output:\n\`\`\`\n${stackProbe.output.trim()}\n\`\`\``,
            { stackProbeFailed: true, output: stackProbe.output },
          );
        }

        if (stackProbe.status === "stacked") {
          if (!branchName) {
            return respond("Could not determine the current branch name for this GitHub stack.", {
              stackSyncFailed: true,
              stackViewOutput: stackProbe.output,
            });
          }

          cycleCount++;
          if (stackProbe.branches.length === 0 || !stackProbe.branches.includes(branchName)) {
            cycleCount = 0;
            return respond(
              `Could not identify every branch in the GitHub stack on \`${branchName}\`. ` +
                "No branches were published and stack synchronization was not started.\n\n" +
                `### gh stack view output:\n\`\`\`\n${stackProbe.output.trim()}\n\`\`\``,
              {
                stackProbeFailed: true,
                stackViewOutput: stackProbe.output,
                stackBranches: stackProbe.branches,
              },
            );
          }

          const initialStackBase = stackProbe.baseBranch?.trim() || null;
          if (options.workspaceController && !initialStackBase) {
            cycleCount = 0;
            return respond(
              "The GitHub stack base could not be determined from the initial probe. No branches were published and stack synchronization was not started.",
              {
                stackSyncFailed: true,
                stackBaseUnknown: true,
                stackProbeOutput: stackProbe.output,
                stackBranches: stackProbe.branches,
                workspaceOwnership: "unavailable",
              },
            );
          }

          const initialOwnership = await adoptStackOwnership(
            cwd,
            stackProbe.branches,
            initialStackBase,
            branchName,
            signal,
          );
          const stackOwnershipDetails = initialOwnership.details;
          if (!initialOwnership.success) {
            cycleCount = 0;
            return respond(
              "The local GitHub stack exists, but workspace ownership adoption failed. No branches were published and stack synchronization was not started.",
              {
                stackSyncFailed: true,
                stackProbeOutput: stackProbe.output,
                stackBranches: stackProbe.branches,
                ...stackOwnershipDetails,
              },
            );
          }

          const missingStackBranches: string[] = [];
          for (const stackBranch of stackProbe.branches) {
            const branchOnOrigin = await branchExistsOnOrigin(cwd, stackBranch, signal);
            if (branchOnOrigin === null) {
              cycleCount = 0;
              return respond(
                `Could not determine whether stack branch \`${stackBranch}\` exists on origin. ` +
                  "No branches were published and stack synchronization was not started; fix remote access and try again.",
                {
                  stackBootstrapFailed: true,
                  branch: stackBranch,
                  remoteLookupFailed: true,
                  ...stackOwnershipDetails,
                },
              );
            }
            if (!branchOnOrigin) missingStackBranches.push(stackBranch);
          }

          for (const stackBranch of missingStackBranches) {
            notify(`Publishing missing stack branch \`${stackBranch}\`…`);
            const bootstrap =
              stackBranch === branchName
                ? await gitPushToOrigin(cwd, signal)
                : await gitPushBranchToOrigin(cwd, stackBranch, signal);
            if (!bootstrap.success) {
              cycleCount = 0;
              return respond(
                `## ⚠️ GitHub Stack Bootstrap Failed\n\n` +
                  `The stack branch \`${stackBranch}\` was not present on origin, and its bootstrap push failed.\n\n` +
                  `### Error output:\n\`\`\`\n${bootstrap.output.trim()}\n\`\`\`\n\n` +
                  `Fix the push error and call \`push_and_check_ci\` again.`,
                {
                  stackBootstrapFailed: true,
                  branch: stackBranch,
                  errorOutput: bootstrap.output,
                  ...stackOwnershipDetails,
                },
              );
            }
          }

          notify(`GitHub stack detected on \`${branchName}\` — syncing…`);
          const syncResult = await runGhStackSync(cwd, signal, stackRunner);

          if (!syncResult.success) {
            const [conflictPaths, conflictBranch] = await Promise.all([
              getUnmergedPaths(cwd, signal),
              currentBranch(cwd, signal),
            ]);
            cycleCount = 0;
            if (conflictPaths.length > 0) {
              return respond(
                `## ⚠️ GitHub Stack Sync Conflicts\n\n` +
                  `\`gh stack sync\` started a rebase and left unresolved conflicts on ` +
                  `\`${conflictBranch ?? "an unknown stack branch"}\`. The rebase state is preserved.\n\n` +
                  `### Conflicting files:\n${formatConflictList(conflictPaths)}\n\n` +
                  `### Sync output:\n\`\`\`\n${syncResult.output.trim()}\n\`\`\`\n\n` +
                  `Call the \`merge_conflicts\` agent to resolve these conflicts. ` +
                  `After it finishes, call \`push_and_check_ci\` again.`,
                {
                  mergeConflict: true,
                  stackSyncConflict: true,
                  rebaseStatePreserved: true,
                  workspaceBranch: branchName,
                  conflictBranch,
                  conflictPaths,
                  syncOutput: syncResult.output,
                  instructions: 'Call the "merge_conflicts" agent to resolve the preserved rebase.',
                  ...stackOwnershipDetails,
                },
              );
            }

            const restoration = await restoreOwnedBranch(cwd, branchName);
            return respond(
              `## ⚠️ GitHub Stack Sync Failed\n\n` +
                `Failed to sync the GitHub stack on \`${branchName}\`. No unmerged paths ` +
                `were reported.\n\n### Error output:\n\`\`\`\n${syncResult.output.trim()}\n\`\`\`\n\n` +
                (restoration.restored
                  ? `The owned workspace branch was restored. Fix the stack synchronization error and call \`push_and_check_ci\` again.`
                  : `The owned workspace branch could not be restored safely. Stop and inspect the workspace manually.`),
              {
                stackSyncFailed: true,
                workspaceRestored: restoration.restored,
                currentBranch: restoration.currentBranch,
                errorOutput: syncResult.output,
                restoreOutput: restoration.restoreOutput,
                instructions: restoration.restored
                  ? "Fix the gh stack sync error, then call push_and_check_ci again."
                  : "Stop and inspect the workspace manually.",
                ...stackOwnershipDetails,
              },
            );
          }

          const restoration = await restoreOwnedBranch(cwd, branchName);
          if (!restoration.restored) {
            cycleCount = 0;
            return respond(
              `GitHub stack sync completed but did not restore the owned workspace branch. ` +
                `It started on \`${branchName}\` and is now on \`${restoration.currentBranch ?? "no branch"}\`. ` +
                "Stop and inspect the workspace manually.",
              {
                stackSyncFailed: true,
                workspaceRestored: false,
                originalBranch: branchName,
                currentBranch: restoration.currentBranch,
                restoreOutput: restoration.restoreOutput,
                ...stackOwnershipDetails,
              },
            );
          }

          notify("Stack sync succeeded — submitting the stack…");
          const submitResult = await runGhStackSubmit(cwd, signal, stackRunner);
          const submitRestoration = await restoreOwnedBranch(cwd, branchName);
          if (!submitRestoration.restored) {
            cycleCount = 0;
            if (submitResult.success) {
              return respond(
                `GitHub stack submission completed, but the owned workspace branch could not be restored before remote linking. ` +
                  `It started on \`${branchName}\` and is now on \`${submitRestoration.currentBranch ?? "no branch"}\`. ` +
                  "Remote linking and readiness checking were skipped; stop and inspect the workspace manually.",
                {
                  stackSubmitSucceeded: true,
                  stackSubmitRestorationFailed: true,
                  stackLinkAttempted: false,
                  remoteStackLinked: false,
                  workspaceRestored: false,
                  originalBranch: branchName,
                  currentBranch: submitRestoration.currentBranch,
                  errorOutput: submitRestoration.restoreOutput,
                  restoreOutput: submitRestoration.restoreOutput,
                  ...stackOwnershipDetails,
                },
              );
            }
            return respond(
              `GitHub stack submission failed, and the owned workspace branch was not restored. ` +
                `It started on \`${branchName}\` and is now on \`${submitRestoration.currentBranch ?? "no branch"}\`. ` +
                "Stop and inspect the workspace manually.",
              {
                stackSubmitFailed: true,
                stackSubmitSucceeded: false,
                stackLinkAttempted: false,
                remoteStackLinked: false,
                workspaceRestored: false,
                originalBranch: branchName,
                currentBranch: submitRestoration.currentBranch,
                errorOutput: submitResult.output,
                restoreOutput: submitRestoration.restoreOutput,
                ...stackOwnershipDetails,
              },
            );
          }
          if (!submitResult.success) {
            cycleCount = 0;
            return respond(
              `## ⚠️ GitHub Stack Submit Failed\n\n` +
                `The stack synced successfully, but \`gh stack submit --auto --no-comments\` failed.\n\n` +
                `### Error output:\n\`\`\`\n${submitResult.output.trim()}\n\`\`\`\n\n` +
                `The owned workspace branch was restored. Fix the submission error and call \`push_and_check_ci\` again.`,
              {
                stackSubmitFailed: true,
                stackSubmitSucceeded: false,
                stackLinkAttempted: false,
                remoteStackLinked: false,
                workspaceRestored: true,
                currentBranch: branchName,
                errorOutput: submitResult.output,
                restoreOutput: submitRestoration.restoreOutput,
                instructions:
                  "Fix the gh stack submit --auto --no-comments error, then call push_and_check_ci again.",
                ...stackOwnershipDetails,
              },
            );
          }

          notify("Stack submitted — refreshing stack metadata before linking…");
          const postSubmitStackProbe = await probeGhStack(cwd, signal, stackRunner);
          const postSubmitStackProbeDetails = {
            status: postSubmitStackProbe.status,
            output: postSubmitStackProbe.output,
            branches: postSubmitStackProbe.branches,
            baseBranch: postSubmitStackProbe.baseBranch,
          };
          const postSubmitStackProbeInfo = {
            postSubmitStackProbe: postSubmitStackProbeDetails,
            postSubmitStackProbeDetails,
            postSubmitStackProbeOutput: postSubmitStackProbe.output,
            postSubmitStackProbeStatus: postSubmitStackProbe.status,
            postSubmitStackProbeBranches: postSubmitStackProbe.branches,
            postSubmitStackProbeBaseBranch: postSubmitStackProbe.baseBranch,
            postSubmitStackBranches: postSubmitStackProbe.branches,
            postSubmitStackBase: postSubmitStackProbe.baseBranch,
          };

          if (
            postSubmitStackProbe.status !== "stacked" ||
            postSubmitStackProbe.branches.length === 0 ||
            !postSubmitStackProbe.branches.includes(branchName)
          ) {
            cycleCount = 0;
            return respond(
              "GitHub stack submission completed and the owned workspace branch was restored, but a fresh stack probe did not report a complete stack. Remote linking and readiness checking were skipped; inspect the stack metadata and call push_and_check_ci again.\n\n" +
                "### Post-submit gh stack view output:\n```\n" +
                postSubmitStackProbe.output.trim() +
                "\n```",
              {
                stackSubmitSucceeded: true,
                stackLinkFailed: true,
                remoteStackLinkFailed: true,
                stackLinkAttempted: false,
                remoteStackLinked: false,
                postSubmitStackProbeFailed: true,
                workspaceRestored: true,
                currentBranch: branchName,
                workspaceOwnership: "unavailable",
                workspaceOwnershipFailed: true,
                workspaceOwnershipFailure: {
                  stage: "probe",
                  reason: "active-branch-not-in-refreshed-stack",
                  activeBranch: branchName,
                  branches: postSubmitStackProbe.branches,
                },
                ...postSubmitStackProbeInfo,
              },
            );
          }

          const stackBase = postSubmitStackProbe.baseBranch?.trim() || null;
          if (!stackBase) {
            cycleCount = 0;
            return respond(
              "GitHub stack submission completed and the owned workspace branch was restored, but the refreshed stack base branch could not be determined. Remote linking and readiness checking were skipped; inspect the stack metadata and call push_and_check_ci again.",
              {
                stackSubmitSucceeded: true,
                stackLinkFailed: true,
                remoteStackLinkFailed: true,
                stackLinkAttempted: false,
                remoteStackLinked: false,
                stackBaseUnknown: true,
                workspaceRestored: true,
                currentBranch: branchName,
                workspaceOwnership: "unavailable",
                workspaceOwnershipFailed: true,
                workspaceOwnershipFailure: {
                  stage: "probe",
                  reason: "base-branch-unknown",
                  branches: postSubmitStackProbe.branches,
                },
                ...postSubmitStackProbeInfo,
              },
            );
          }

          const refreshedOwnership = await adoptStackOwnership(
            cwd,
            postSubmitStackProbe.branches,
            stackBase,
            branchName,
            signal,
          );
          if (!refreshedOwnership.success) {
            cycleCount = 0;
            return respond(
              "The stack was submitted, but refreshed workspace ownership adoption failed. Remote linking and readiness checking were skipped; fix the workspace ownership issue and try again.",
              {
                stackSubmitSucceeded: true,
                stackLinkFailed: true,
                remoteStackLinkFailed: true,
                stackLinkAttempted: false,
                remoteStackLinked: false,
                workspaceRestored: true,
                currentBranch: branchName,
                ...refreshedOwnership.details,
                ...postSubmitStackProbeInfo,
              },
            );
          }
          const stackOwnershipAfterSubmit = refreshedOwnership.details;
          const stackLinkRequired = postSubmitStackProbe.branches.length > 1;
          let stackLinkResult = { success: true, output: "" };
          let linkRestoration = {
            restored: true,
            currentBranch: branchName,
            restoreOutput: "",
          };
          let remoteStackRebuilt = false;
          let remoteStackRebuildOutputs:
            | {
                initialLinkOutput: string;
                initialLinkRestorationOutput: string;
                remoteUnstackOutput: string;
                remoteUnstackRestorationOutput: string;
                localInitOutput: string;
                localInitRestorationOutput: string;
                retryLinkOutput?: string;
                retryLinkRestorationOutput?: string;
              }
            | undefined;

          if (stackLinkRequired) {
            notify("Stack submitted — linking the remote stack…");
            stackLinkResult = await runGhStackLink(
              cwd,
              postSubmitStackProbe.branches,
              stackBase,
              signal,
              stackRunner,
            );
            // Linking can traverse branches too. Restore again even though the
            // submit boundary was already restored, so readiness starts from the
            // owned checkout and a failed link cannot leak another branch.
            linkRestoration = await restoreOwnedBranch(cwd, branchName);
          }

          // GitHub rejects adding a new middle PR to an already-submitted
          // stack. Rebuild only for that exact rejection: a generic link
          // failure must never destructively unstack the remote stack.
          if (
            stackLinkRequired &&
            !stackLinkResult.success &&
            linkRestoration.restored &&
            isMiddleInsertionRejectionOutput(stackLinkResult.output)
          ) {
            notify("Remote stack link rejected a middle insertion — rebuilding the remote stack…");
            const remoteUnstack = await runGhStackUnstack(cwd, signal, stackRunner);
            const remoteUnstackRestoration = await restoreOwnedBranch(cwd, branchName);

            // Keep remote unstack caller-signal-aware: cancellation must not
            // be reported as a completed remote mutation. It may nevertheless
            // partially remove gh's local tracking, so local init is mandatory
            // recovery and intentionally ignores the caller's signal.
            const localInit = await runGhStackInit(
              cwd,
              postSubmitStackProbe.branches,
              stackBase,
              undefined,
              stackRunner,
            );
            const localInitRestoration = await restoreOwnedBranch(cwd, branchName);
            remoteStackRebuildOutputs = {
              initialLinkOutput: stackLinkResult.output,
              initialLinkRestorationOutput: linkRestoration.restoreOutput,
              remoteUnstackOutput: remoteUnstack.output,
              remoteUnstackRestorationOutput: remoteUnstackRestoration.restoreOutput,
              localInitOutput: localInit.output,
              localInitRestorationOutput: localInitRestoration.restoreOutput,
            };

            const reconstructionDetails = {
              stackSubmitSucceeded: true,
              stackLinkFailed: true,
              remoteStackLinkFailed: true,
              stackLinkAttempted: true,
              stackLinkSucceeded: false,
              remoteStackLinked: false,
              remoteStackRebuildAttempted: true,
              remoteStackRebuilt: false,
              remoteUnstackAttempted: true,
              remoteUnstackSucceeded: remoteUnstack.success,
              remoteStackState: remoteUnstack.success ? "unstacked" : "unknown",
              localInitAttempted: true,
              localInitSucceeded: localInit.success,
              localTrackingRecovered: localInit.success && localInitRestoration.restored,
              workspaceRestored: localInitRestoration.restored,
              currentBranch: localInitRestoration.currentBranch,
              ...remoteStackRebuildOutputs,
              ...postSubmitStackProbeInfo,
              ...stackOwnershipAfterSubmit,
            };

            if (!remoteUnstack.success || !remoteUnstackRestoration.restored) {
              cycleCount = 0;
              return respond(
                "The remote stack link required rebuilding, but remote unstack or checkout restoration failed. Local tracking cleanup was attempted; readiness was skipped. Stop and inspect the workspace and remote stack manually.",
                {
                  ...reconstructionDetails,
                  remoteUnstackRestorationSucceeded: remoteUnstackRestoration.restored,
                  remoteStackRebuildFailed: true,
                  retryLinkAttempted: false,
                  retryLinkSucceeded: false,
                  readinessSkipped: true,
                  instructions: "Stop and inspect the workspace manually.",
                },
              );
            }

            if (!localInit.success || !localInitRestoration.restored) {
              cycleCount = 0;
              return respond(
                "The remote stack was unstacked, but local stack tracking recovery failed. Readiness was skipped; stop and inspect the workspace manually.",
                {
                  ...reconstructionDetails,
                  remoteUnstackRestorationSucceeded: true,
                  localTrackingRecoveryFailed: true,
                  remoteStackRebuildFailed: true,
                  retryLinkAttempted: false,
                  retryLinkSucceeded: false,
                  readinessSkipped: true,
                  instructions: "Stop and inspect the workspace manually.",
                },
              );
            }

            notify("Remote stack rebuilt — retrying the remote stack link…");
            const retryLink = await runGhStackLink(
              cwd,
              postSubmitStackProbe.branches,
              stackBase,
              signal,
              stackRunner,
            );
            const retryLinkRestoration = await restoreOwnedBranch(cwd, branchName);
            remoteStackRebuildOutputs.retryLinkOutput = retryLink.output;
            remoteStackRebuildOutputs.retryLinkRestorationOutput =
              retryLinkRestoration.restoreOutput;
            stackLinkResult = retryLink;
            if (!retryLink.success || !retryLinkRestoration.restored) {
              cycleCount = 0;
              return respond(
                retryLink.success
                  ? "The remote stack was rebuilt and linked, but the owned workspace branch could not be restored before readiness checking. Stop and inspect the workspace manually."
                  : "The remote stack was rebuilt, but the retry of remote stack linking failed. Readiness was skipped.",
                {
                  ...reconstructionDetails,
                  remoteUnstackRestorationSucceeded: true,
                  localTrackingRecovered: true,
                  localInitSucceeded: true,
                  retryLinkAttempted: true,
                  retryLinkSucceeded: retryLink.success,
                  remoteStackRebuilt: retryLink.success,
                  remoteStackLinked: retryLink.success,
                  remoteStackState: retryLink.success ? "linked" : "unstacked",
                  remoteStackRebuildFailed: true,
                  stackLinkSucceeded: retryLink.success,
                  readinessSkipped: true,
                  workspaceRestored: retryLinkRestoration.restored,
                  currentBranch: retryLinkRestoration.currentBranch,
                  ...remoteStackRebuildOutputs,
                  ...(retryLinkRestoration.restored ? {} : { workspaceRestorationFailed: true }),
                  instructions:
                    retryLink.success && !retryLinkRestoration.restored
                      ? "Stop and inspect the workspace manually."
                      : "Fix the remote stack link error, then call push_and_check_ci again.",
                },
              );
            }
            remoteStackRebuilt = true;
            if (signal?.aborted) {
              cycleCount = 0;
              return respond(
                "The remote stack was rebuilt and linked, but the operation was cancelled before readiness checking. The owned workspace branch was restored.",
                {
                  ...reconstructionDetails,
                  remoteUnstackRestorationSucceeded: true,
                  localTrackingRecovered: true,
                  retryLinkAttempted: true,
                  retryLinkSucceeded: true,
                  remoteStackRebuilt: true,
                  remoteStackLinked: true,
                  remoteStackState: "linked",
                  stackLinkSucceeded: true,
                  workspaceRestored: true,
                  currentBranch: retryLinkRestoration.currentBranch,
                  ...remoteStackRebuildOutputs,
                  readinessSkipped: true,
                },
              );
            }
          }

          if (stackLinkRequired && !stackLinkResult.success) {
            cycleCount = 0;
            const restorationMessage = linkRestoration.restored
              ? "The owned workspace branch was restored."
              : "The owned workspace branch could not be restored safely; stop and inspect the workspace manually.";
            return respond(
              `## ⚠️ Remote GitHub Stack Link Failed\n\n` +
                `\`gh stack link\` failed.\n\n### Error output:\n\`\`\`\n${stackLinkResult.output.trim()}\n\`\`\`` +
                `\n\n${restorationMessage}`,
              {
                stackSubmitSucceeded: true,
                stackLinkFailed: true,
                remoteStackLinkFailed: true,
                stackLinkAttempted: true,
                stackLinkSucceeded: false,
                remoteStackLinked: false,
                workspaceRestored: linkRestoration.restored,
                currentBranch: linkRestoration.currentBranch,
                stackLinkOutput: stackLinkResult.output,
                output: stackLinkResult.output,
                errorOutput: stackLinkResult.output,
                restoreOutput: linkRestoration.restoreOutput,
                ...(linkRestoration.restored ? {} : { workspaceRestorationFailed: true }),
                remoteStackRebuildAttempted: false,
                remoteStackRebuilt: false,
                ...postSubmitStackProbeInfo,
                ...stackOwnershipAfterSubmit,
                instructions: linkRestoration.restored
                  ? "Fix the remote stack link error, then call push_and_check_ci again."
                  : "Stop and inspect the workspace manually.",
              },
            );
          }
          if (stackLinkRequired && !linkRestoration.restored) {
            cycleCount = 0;
            return respond(
              "Remote GitHub stack linking succeeded, but the owned workspace branch could not be restored before readiness checking. Stop and inspect the workspace manually.",
              {
                stackSubmitSucceeded: true,
                stackLinkAttempted: true,
                stackLinkSucceeded: true,
                remoteStackLinked: true,
                stackLinkRestorationFailed: true,
                workspaceRestorationFailed: true,
                remoteStackRebuildAttempted: false,
                remoteStackRebuilt: false,
                workspaceRestored: false,
                currentBranch: linkRestoration.currentBranch,
                stackLinkOutput: stackLinkResult.output,
                errorOutput: linkRestoration.restoreOutput,
                restoreOutput: linkRestoration.restoreOutput,
                ...postSubmitStackProbeInfo,
                ...stackOwnershipAfterSubmit,
              },
            );
          }

          pushedSha = (await getHeadSha(cwd, signal)) ?? undefined;
          notify(
            stackLinkRequired
              ? "Stack submitted and linked. Resolving and checking every stack branch…"
              : "Stack submitted. Remote linking is not required for this single-branch stack; resolving and checking its branch…",
          );

          const stackReadiness = await stackReadinessRunner(
            cwd,
            postSubmitStackProbe.branches,
            signal,
            notify,
            {
              resolveBranch: resolveStackBranch,
              pollChecks,
              fetchFailureLogs,
              markPrReady,
            },
          );
          cycleCount = 0;
          const readinessMessage = formatStackReadiness(stackReadiness);
          return respond(
            stackLinkRequired
              ? readinessMessage
              : "Remote stack linking was not attempted because this single-branch stack does not require it.\n\n" +
                  readinessMessage,
            {
              stackReadiness: true,
              allChecksPassed: stackReadiness.allChecksPassed,
              allReady: stackReadiness.allReady,
              success: stackReadiness.allReady,
              branches: stackReadiness.branches,
              stackSubmitSucceeded: true,
              stackLinkAttempted: stackLinkRequired,
              stackLinkRequired,
              ...(stackLinkRequired
                ? { stackLinkSucceeded: true, stackLinkOutput: stackLinkResult.output }
                : { stackLinkSkipped: true, stackLinkSkipReason: "single-branch-stack" }),
              remoteStackLinked: stackLinkRequired,
              remoteStackRebuildAttempted: remoteStackRebuildOutputs !== undefined,
              remoteStackRebuilt,
              ...(remoteStackRebuildOutputs
                ? { remoteStackState: "linked", ...remoteStackRebuildOutputs }
                : {}),
              workspaceRestored: true,
              ...postSubmitStackProbeInfo,
              ...stackOwnershipAfterSubmit,
            },
          );
        } else {
          // ── 2. Check if base branch is ahead — merge if so ─────────────
          // Keep the PR branch up to date with the base branch before pushing
          // and running CI. This prevents CI from testing a stale branch.
          prBase = await getPrBaseBranch(cwd, signal);

          if (prBase) {
            const baseAhead = await isBaseBranchAhead(cwd, prBase, signal);
            if (baseAhead) {
              if (!branchName) {
                return respond(
                  `Could not determine the current branch name. ` + `Fix manually and try again.`,
                  {
                    mergeFailed: true,
                    error: "Unable to determine current branch",
                  },
                );
              }

              notify(`Merging ${prBase} into ${branchName} via worktree…`);

              const mergeResult = await mergeBaseBranchIntoCurrent(cwd, prBase, branchName, signal);

              if (!mergeResult.success) {
                if (mergeResult.conflictPaths.length > 0) {
                  const conflictList = formatConflictList(mergeResult.conflictPaths);

                  return respond(
                    `## ⚠️ Merge Conflicts Detected\n\n` +
                      `The PR branch \`${branchName}\` has conflicts with the base branch ` +
                      `\`${prBase}\`. I attempted to merge the latest \`${prBase}\` into ` +
                      `\`${branchName}\` but there are unresolved conflicts.\n\n` +
                      `### Conflicting files:\n${conflictList}\n\n` +
                      `### Merge output:\n\`\`\`\n${mergeResult.output.trim()}\n\`\`\`\n\n` +
                      `### To resolve:\n` +
                      `1. Resolve the conflicts in the listed files\n` +
                      `2. \`git add\` the resolved files\n` +
                      `3. Commit the merge (the merge message is pre-filled)\n` +
                      `4. Run \`push_and_check_ci\` again`,
                    {
                      mergeConflict: true,
                      baseBranch: prBase,
                      currentBranch: branchName,
                      conflictPaths: mergeResult.conflictPaths,
                      mergeOutput: mergeResult.output,
                    },
                  );
                }

                // Merge failed but no conflicts — likely a tooling or network error.
                return respond(
                  `## ⚠️ Merge Failed\n\n` +
                    `Failed to merge \`${prBase}\` into \`${branchName}\`. ` +
                    `No merge conflicts were detected — this is likely a ` +
                    `transient tooling issue (e.g. network or auth).\n\n` +
                    `### Error output:\n\`\`\`\n${mergeResult.output.trim()}\n\`\`\`\n\n` +
                    `Try running \`push_and_check_ci\` again. ` +
                    `If the problem persists, merge \`${prBase}\` into your branch manually ` +
                    `(\`git fetch origin ${prBase} && git merge origin/${prBase}\`).`,
                  {
                    mergeFailed: true,
                    baseBranch: prBase,
                    currentBranch: branchName,
                    errorOutput: mergeResult.output,
                  },
                );
              }

              notify(
                `Successfully merged \`${prBase}\` into \`${branchName}\` ` +
                  `without conflicts. Proceeding with push…`,
              );
            }
          }

          // ── 2. Check if there's something to push ──────────────────────
          const hasSomethingToPush = await needsPush(cwd, signal);

          if (hasSomethingToPush) {
            cycleCount++;

            // ── Pull remote changes if local and remote have diverged ────────
            notify("Checking if remote has newer commits…");

            const needsPull = await needsPullBeforePush(cwd, signal);

            if (needsPull) {
              notify(
                `Remote and local have diverged — pulling changes via merge (non-history-rewriting)…`,
              );

              const pullResult = await pullRemoteChanges(cwd, signal);

              if (!pullResult.success) {
                cycleCount = 0;

                if (pullResult.conflictPaths.length > 0) {
                  const conflictList = formatConflictList(pullResult.conflictPaths);

                  return respond(
                    `## ⚠️ Merge Conflicts During Pull\n\n` +
                      `The remote branch has commits ahead of local. ` +
                      `I attempted to pull them via merge but there are unresolved ` +
                      `conflicts.\n\n` +
                      `### Conflicting files:\n${conflictList}\n\n` +
                      `### Pull output:\n\`\`\`\n${pullResult.output.trim()}\n\`\`\`\n\n` +
                      `### To resolve:\n` +
                      `1. Resolve the conflicts in the listed files\n` +
                      `2. \`git add\` the resolved files\n` +
                      `3. Commit the merge\n` +
                      `4. Run \`push_and_check_ci\` again`,
                    {
                      mergeConflict: true,
                      conflictPaths: pullResult.conflictPaths,
                      pullOutput: pullResult.output,
                    },
                  );
                }

                // Pull failed but no conflicts — likely a tooling or network error.
                return respond(
                  `## ⚠️ Pull Failed\n\n` +
                    `Failed to pull remote changes. ` +
                    `No merge conflicts were detected — this is likely a ` +
                    `transient tooling issue (e.g. network or auth).\n\n` +
                    `### Error output:\n\`\`\`\n${pullResult.output.trim()}\n\`\`\`\n\n` +
                    `Try running \`push_and_check_ci\` again. ` +
                    `If the problem persists, pull manually.`,
                  { pullFailed: true, errorOutput: pullResult.output },
                );
              }

              notify("Pull succeeded. Proceeding with push…");
            }

            // Push
            notify("Pushing to origin…");

            const pushResult = await gitPush(cwd, signal);

            if (!pushResult.success) {
              cycleCount = 0;
              return respond(
                `git push failed:\n\n\`\`\`\n${pushResult.output}\n\`\`\`\n\n` +
                  `Fix the push error and try again.`,
                { pushFailed: true, output: pushResult.output },
              );
            }

            // Pin all subsequent checks to the exact commit we just pushed.
            pushedSha = (await getHeadSha(cwd, signal)) ?? undefined;
          } else {
            notify("Nothing to push — checking CI for current HEAD…");
            pushedSha = (await getHeadSha(cwd, signal)) ?? undefined;
          }
        }

        // ── Create draft PR if none exists ────────────────────────────
        // Runs whether or not we pushed: a branch already on origin (e.g.
        // pushed manually) should still get a PR opened if it lacks one.
        const existingPr = await detectPrNumber(cwd, signal);
        if (!existingPr) {
          notify("Creating draft pull request…");

          const targetBase = prBase ?? (await getPrBaseBranch(cwd, signal));
          if (!targetBase) {
            return respond("Draft PR creation failed: could not determine a target branch.", {
              prCreationFailed: true,
              output: "Could not determine a target branch.",
            });
          }

          // Generate PR body from commits unique to the inferred target branch.
          const prBody = await generatePrBody(cwd, targetBase, signal);

          // Use provided title or auto-generate from the branch name.
          const prTitle = await generatePrTitle(cwd, signal);

          const prResult = await createDraftPr(cwd, prTitle, prBody, targetBase, signal);

          if (!prResult.success) {
            return respond(`Draft PR creation failed:\n\n\`\`\`\n${prResult.output}\n\`\`\``, {
              prCreationFailed: true,
              output: prResult.output,
            });
          }

          const prUrl = prResult.url ? prResult.url : "(see gh output)";
          notify(`Draft PR created: ${prUrl}`);
        } else {
          notify(`PR #${existingPr} already exists — skipping creation.`);
        }

        const cycle = cycleCount;

        // ── 3. Check if PR is already closed/merged (auto-merge may have landed) ─
        const prState = await getPrState(cwd, signal);
        if (prState === "MERGED") {
          cycleCount = 0;
          return respond(`✅ Pull request was already merged. Nothing more to do.`, {
            prMerged: true,
          });
        }
        if (prState === "CLOSED") {
          cycleCount = 0;
          return respond(
            `Pull request is closed (not merged). No CI checks to poll. ` +
              `If you need to re-open it, do so manually and then call push_and_check_ci again.`,
            { prClosed: true },
          );
        }

        // ── 4. Poll checks ───────────────────────────────────────────────
        notify(`Push succeeded. Polling CI (cycle ${cycle}/${MAX_CYCLES})…`);

        const pollResult = await pollChecks(cwd, signal, notify, pushedSha);

        if (pollResult.timedOut) {
          cycleCount = 0;
          return respond(
            `Timed out after ${pollResult.polls} polls. ` +
              `waiting for checks on ${pollResult.mode}. ` +
              `Some checks are still running. Last status:\n\n` +
              formatChecks(pollResult.checks) +
              `\n\nStop here — tell the user CI timed out.`,
            {
              checks: pollResult.checks,
              mode: pollResult.mode,
              timedOut: true,
            },
          );
        }

        // ── 5. Categorise ────────────────────────────────────────────────
        const failures = pollResult.checks.filter((c) => isFailure(c.bucket));

        // ⚠️ No checks at all — don't claim CI is green.
        if (pollResult.checks.length === 0) {
          cycleCount = 0;
          return respond(
            `No CI checks are configured for ${pollResult.mode}. ` +
              `The push succeeded, but nothing ran — there is no CI signal ` +
              `to confirm the change is good. Tell the user no checks ran ` +
              `rather than claiming CI passed.`,
            { checks: [], mode: pollResult.mode, noChecks: true },
          );
        }

        // ✅ All passed
        if (failures.length === 0) {
          cycleCount = 0;

          const successLines = [
            `All ${pollResult.checks.length} checks passed for ${pollResult.mode}. ✅`,
            "",
            formatChecks(pollResult.checks),
          ];

          // ── Mark PR ready for review ──────────────────────────────
          const prNum = await detectPrNumber(cwd, signal);
          if (prNum) {
            notify(`CI passed for PR #${prNum}. Marking ready for review…`);

            const ready = await markPrReady(cwd, signal);
            if (ready) {
              successLines.push("", `✅ PR #${prNum} marked as ready for review.`);
            } else {
              successLines.push(
                "",
                `⚠️ Could not mark PR #${prNum} as ready (may already be ready).`,
              );
            }

            // ── Re-request review from previous reviewer ──────────
            const previousReviewer = await getLatestChangesRequestedReviewer(cwd, signal);
            if (previousReviewer) {
              notify(
                `Re-requesting review from @${previousReviewer} (previously requested changes)…`,
              );
              const reRequested = await addReviewers(cwd, previousReviewer, signal);
              if (reRequested) {
                successLines.push("", `📨 Re-requested review from @${previousReviewer}.`);
              }
            }
          } else {
            successLines.push("", "⚠️ No PR detected — push was not preceded by PR creation.");
          }

          return respond(successLines.join("\n"), {
            checks: pollResult.checks,
            mode: pollResult.mode,
            allPassed: true,
          });
        }

        // ── 6. Fetch failure logs ────────────────────────────────────────
        notify(`${failures.length} check(s) failed. Fetching logs…`);

        const failureLogs = await fetchFailureLogs(failures, cwd, signal);
        const report = buildReport(pollResult.mode, pollResult.checks, failures, failureLogs);

        // ── 7. Cycle limit ───────────────────────────────────────────────
        if (cycle >= MAX_CYCLES) {
          cycleCount = 0;
          return respond(
            report +
              `\n\nThis was attempt ${cycle}/${MAX_CYCLES}. Stop here — ` +
              `tell the user you were unable to fix CI after ${MAX_CYCLES} attempts ` +
              `and show them the remaining failures.`,
            {
              checks: pollResult.checks,
              mode: pollResult.mode,
              failureLogs,
              exhausted: true,
            },
          );
        }

        // ── 8. Return failures for the AI to fix ─────────────────────────
        return respond(
          report +
            `\n\nThis is attempt ${cycle}/${MAX_CYCLES}. ` +
            `Fix these failures with minimal code changes. ` +
            `Do not modify workflow files unless the failure is clearly a workflow bug. ` +
            `Run relevant checks locally if possible to verify before committing. ` +
            `After committing your fix, call push_and_check_ci again.`,
          {
            checks: pollResult.checks,
            mode: pollResult.mode,
            failureLogs,
            cycle,
          },
        );
      },
    });
  };
}

export default createFixCiExtension;

// ── Stack helpers ────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatConflictList(paths: string[]): string {
  return paths.map((p) => `- \`${p}\``).join("\n");
}

function formatStackReadiness(result: StackReadinessResult): string {
  const lines = [
    result.allReady
      ? "## GitHub Stack CI Passed and Stack Ready ✅"
      : result.allChecksPassed
        ? "## ⚠️ GitHub Stack CI Passed, Stack Not Ready"
        : "## ⚠️ GitHub Stack CI Did Not Pass",
    "",
    result.allReady
      ? "Every stack branch has a passing CI signal and every draft PR is ready."
      : result.allChecksPassed
        ? "CI passed, but the stack was not fully marked ready."
        : "No stack PRs were marked ready because every branch must resolve and pass CI first.",
    "",
  ];

  for (const branch of result.branches) {
    const sha = branch.sha ? branch.sha.slice(0, 8) : "missing SHA";
    const pr = branch.prNumber === null ? "missing open PR" : `PR #${branch.prNumber}`;
    lines.push(`### \`${branch.branch}\` — ${pr} @ \`${sha}\``);
    if (branch.prState)
      lines.push(`PR state: ${branch.prState}${branch.isDraft ? " (draft)" : ""}`);
    if (branch.checks.length === 0) {
      lines.push("No checks ran.");
    } else {
      lines.push(formatChecks(branch.checks));
    }
    if (branch.timedOut) {
      lines.push(`Timed out after ${branch.polls} polls.`);
    }
    if (branch.reason) lines.push(`Action needed: ${branch.reason}.`);
    if (branch.failureLogs.length > 0) {
      lines.push("");
      for (const failureLog of branch.failureLogs) {
        lines.push(`#### Failure logs: ${failureLog.name}`);
        if (failureLog.log) {
          lines.push("```", failureLog.log, "```");
        } else {
          lines.push("_(no logs available)_");
        }
      }
    }
    if (branch.ready === true) lines.push(`✅ PR #${branch.prNumber} marked ready for review.`);
    if (branch.ready === false) {
      lines.push(
        `⚠️ Could not mark PR #${branch.prNumber} ready. Run \`gh pr ready -- ${shellQuote(branch.branch)}\` manually.`,
      );
    }
    if (branch.ready === null && branch.isDraft === false) {
      lines.push(`✅ PR #${branch.prNumber} was already ready for review.`);
    }
    lines.push("");
  }

  if (result.allChecksPassed && !result.allReady) {
    lines.push(
      "CI passed, but the stack is not fully ready. Inspect the warnings above and retry after resolving the reported issue.",
    );
  } else if (!result.allChecksPassed) {
    lines.push("Fix the listed branch/PR or CI issue, then call `push_and_check_ci` again.");
  }
  return lines.join("\n");
}

function formatChecks(checks: CheckResult[]): string {
  return checks
    .map((c) => {
      const icon = isFailure(c.bucket) ? "❌" : c.bucket === "pass" ? "✅" : "⏭️";
      return `${icon} ${c.name}: ${c.state}`;
    })
    .join("\n");
}

function buildReport(
  mode: string,
  allChecks: CheckResult[],
  failures: CheckResult[],
  failureLogs: FailureLog[],
): string {
  const passed = allChecks.filter((c) => !isFailure(c.bucket));
  const lines: string[] = [];

  lines.push(`## CI Results for ${mode}`);
  lines.push("");
  lines.push(`**${failures.length} failed**, ${passed.length} passed`);
  lines.push("");

  if (passed.length > 0) {
    lines.push("### Passed");
    for (const c of passed) {
      lines.push(`- ✅ ${c.name}`);
    }
    lines.push("");
  }

  lines.push("### Failures");
  lines.push("");
  for (const fl of failureLogs) {
    lines.push(`#### ❌ ${fl.name}`);
    if (fl.link) {
      lines.push(`URL: ${fl.link}`);
    }
    lines.push("");
    if (fl.log) {
      lines.push("```");
      lines.push(fl.log);
      lines.push("```");
    } else {
      lines.push("_(no logs available)_");
    }
    lines.push("");
  }

  return lines.join("\n");
}
