/**
 * git-commit extension
 *
 * `git_commit` tool — checks default branch, runs pre-checks (static
 * analysis only), then commits the currently-staged changes with
 * a structured subject, what, and why. Does NOT stage anything itself.
 *
 * Manual `git commit` in bash is blocked by the command-policy extension
 * (its `entries` array bans the "git commit" subcommand), not here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { currentBranch } from "./git-utils.ts";
import { isDefaultBranch, branchExistsOnRemote } from "./logic.ts";
import { hasUpstream } from "./git-utils.ts";
import { formatCommitMessage, gitCommit } from "./logic.ts";
import { runPreChecks } from "./precheck.ts";
import { execAsync, extractErrorOutput } from "./exec-async.ts";

export function gitCommitExtension(pi: ExtensionAPI) {
  // ── Tool: git_commit ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "git_commit",
    label: "Git Commit",
    description:
      "Commit the currently-staged changes with a structured subject, what, and why. " +
      "Pass `add_all: true` to auto-stage all tracked file changes first. " +
      "Runs pre-commit checks (static analysis only) before committing. " +
      "Blocks commits on default branches (main/master).",
    parameters: Type.Object({
      subject: Type.String({
        description: "Imperative commit subject (72 characters or fewer).",
        minLength: 1,
        maxLength: 72,
      }),
      what: Type.String({
        description:
          "Concise, human-readable summary of the behavior or capability changed. " +
          "Do not just list mechanical edits for example.",
        minLength: 1,
        maxLength: 200,
      }),
      why: Type.String({
        description: "Concise inclusive reason why the work in this commit was needed.",
        minLength: 1,
        maxLength: 200,
      }),
      add_all: Type.Boolean({
        description:
          "Auto-stage all changes (`git add -A`) before committing. " +
          "Set to true for quick checkpoints where you want everything changed to be included.",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;

      // 1. Check default branch.
      const branch = await currentBranch(cwd, signal);
      if (branch && (await isDefaultBranch(cwd, branch, signal))) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Cannot commit on "${branch}". ` +
                `Create a feature branch first with \`git checkout -b <branch-name>\`, ` +
                `then commit there.`,
            },
          ],
        };
      }

      // 2. Check if branch exists on remote (only if it has an upstream).
      if (branch && (await hasUpstream(cwd, signal))) {
        if (!(await branchExistsOnRemote(cwd, branch, signal))) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Branch "${branch}" has an upstream configured but does not exist on remote. ` +
                  `This may indicate a deleted remote branch. Push it with \`push_and_check_ci\` or ` +
                  `\`git push -u origin ${branch}\`.`,
              },
            ],
          };
        }
      }

      // 3. Pre-commit checks.
      const completedSteps: string[] = [];
      onUpdate?.({
        content: [{ type: "text", text: "Running pre-commit checks…" }],
      });

      const preCheck = await runPreChecks(cwd, signal, (step) => {
        const icon = step.passed ? "✅" : "❌";
        const time = step.elapsed ? ` (${step.elapsed}s)` : "";
        completedSteps.push(`${icon} ${step.command}${time}`);
        onUpdate?.({
          content: [{ type: "text", text: completedSteps.join("\n") }],
        });
      });

      if (!preCheck.passed) {
        const failedStep = preCheck.steps.find((s) => !s.passed)!;
        const passedSteps = preCheck.steps
          .filter((s) => s.passed)
          .map((s) => `✅ ${s.command}`)
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Pre-commit check failed. Fix the errors before committing.\n\n` +
                (passedSteps ? `${passedSteps}\n` : "") +
                `❌ \`${failedStep.command}\`:\n\`\`\`\n${failedStep.output}\n\`\`\``,
            },
          ],
        };
      }

      // 4. Auto-stage if add_all is set.
      if (params.add_all) {
        completedSteps.push("📦 Staging all changes…");
        onUpdate?.({
          content: [{ type: "text", text: completedSteps.join("\n") }],
        });

        try {
          await execAsync("git add -A", { cwd, timeout: 15_000, signal });
        } catch (err: unknown) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Staging failed:\n\`\`\`\n${extractErrorOutput(err)}\n\`\`\``,
              },
            ],
          };
        }
      }

      // 5. Commit.
      completedSteps.push("Committing…");
      onUpdate?.({
        content: [{ type: "text", text: completedSteps.join("\n") }],
      });

      const message = formatCommitMessage(params.subject, params.what, params.why);
      const result = await gitCommit(cwd, message, signal);

      if (!result.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Commit failed:\n\`\`\`\n${result.output}\n\`\`\``,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: result.output || `Committed: "${params.subject}"`,
          },
        ],
      };
    },
  });
}
