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
import { formatCommitMessage } from "./logic.ts";
import { runGitCommit } from "./orchestration.ts";

export function gitCommitExtension(
  pi: ExtensionAPI,
  options: { assertWorkspace: (cwd: string) => Promise<void> },
) {
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
      const result = await runGitCommit({
        cwd: ctx.cwd,
        message: formatCommitMessage(params.subject, params.what, params.why),
        addAll: params.add_all,
        signal,
        assertWorkspace: options.assertWorkspace,
        onProgress(text) {
          onUpdate?.({ content: [{ type: "text", text }] });
        },
      });

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
