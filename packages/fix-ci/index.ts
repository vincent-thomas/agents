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
import { Object as TObject } from "typebox";
import { currentBranch, isWorktreeDirty } from "./git-utils.ts";
import {
  gitPush,
  getHeadSha,
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
  type CheckResult,
  type FailureLog,
} from "./logic.ts";

const MAX_CYCLES = 3;

/** Shapes a tool result: single text block plus the machine-readable `details`
 * every branch below returns alongside it. */
function respond(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createFixCiExtension(options: { assertWorkspace: (cwd: string) => Promise<void> }) {
  return function (pi: ExtensionAPI) {
    let cycleCount = 0;

    // ── Tool: push_and_check_ci ─────────────────────────────────────────────
    pi.registerTool({
      name: "push_and_check_ci",
      label: "Push & Check CI",
      description:
        "Push the current branch to origin, create a draft PR if none exists, " +
        "poll GitHub Actions checks until they all finish, and if all pass " +
        "mark the PR as ready for review. " +
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

        // ── 1. Check if base branch is ahead — merge if so ─────────────
        // Keep the PR branch up to date with the base branch before pushing
        // and running CI. This prevents CI from testing a stale branch.
        const branchName = await currentBranch(cwd, signal);
        const prBase = await getPrBaseBranch(cwd, signal);

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

        let pushedSha: string | undefined;

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

        // ── Create draft PR if none exists ────────────────────────────
        // Runs whether or not we pushed: a branch already on origin (e.g.
        // pushed manually) should still get a PR opened if it lacks one.
        const existingPr = await detectPrNumber(cwd, signal);
        if (!existingPr) {
          notify("Creating draft pull request…");

          // Generate PR body from commit messages.
          const prBody = await generatePrBody(cwd, signal);

          // Use provided title or auto-generate from the branch name.
          const prTitle = await generatePrTitle(cwd, signal);

          const prResult = await createDraftPr(cwd, prTitle, prBody, signal);

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatConflictList(paths: string[]): string {
  return paths.map((p) => `- \`${p}\``).join("\n");
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
