import { complete } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_LOG_FORMAT,
  buildDiffSummaryPrompt,
  buildStandupPrompt,
  chunkDiff,
  isOnLocalDay,
  localDayRange,
  mergeCommitsByHash,
  parseBranchLog,
  parseRepositoryArguments,
  repositoryLabel,
  type StandupCommit,
} from "./logic.ts";

export interface StandupExtensionOptions {
  /** Cheaper model used only to describe individual commit diffs. */
  model: Model<any>;
  /** Override the identity selected from `git config --global user.email`. */
  authorEmail?: string;
}

interface CommitSummary {
  repository: string;
  commit: StandupCommit;
  summary: string;
}

function responseText(response: Awaited<ReturnType<typeof complete>>): string {
  return response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export function createStandupExtension(options: StandupExtensionOptions) {
  return function standupExtension(pi: ExtensionAPI) {
    const runGit = async (args: string[], cwd?: string): Promise<string> => {
      const result = await pi.exec("git", args, { cwd, timeout: 10 * 60_000 });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
      }
      return result.stdout;
    };

    pi.registerCommand("standup", {
      description: "Summarize today's authored commits across remote repositories",
      handler: async (args, ctx) => {
        await ctx.waitForIdle();

        const setStatus = (message?: string) => {
          if (ctx.hasUI) ctx.ui.setStatus("standup", message);
        };
        const notify = (message: string, level: "info" | "warning" | "error") => {
          if (ctx.hasUI) ctx.ui.notify(message, level);
        };

        let workingDirectory: string | undefined;
        try {
          const repositories = parseRepositoryArguments(args);
          const authorEmail =
            options.authorEmail?.trim() || (await runGit(["config", "--global", "user.email"])).trim();
          if (!authorEmail) throw new Error("No author email configured; set git user.email or provide authorEmail");

          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(options.model);
          if (!auth.ok) throw new Error(auth.error);
          if (!auth.apiKey) {
            throw new Error(`No API key is available for ${options.model.provider}/${options.model.id}`);
          }

          const today = new Date();
          const { since, until } = localDayRange(today);
          workingDirectory = await mkdtemp(join(tmpdir(), "pi-standup-"));
          const summaries: CommitSummary[] = [];

          for (const [repositoryIndex, repository] of repositories.entries()) {
            const label = repositoryLabel(repository);
            const cloneDirectory = join(workingDirectory, `${repositoryIndex}.git`);
            setStatus(`Cloning ${label} (${repositoryIndex + 1}/${repositories.length})…`);
            await runGit(["clone", "--mirror", repository, cloneDirectory]);

            const branchOutput = await runGit(
              ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
              cloneDirectory,
            );
            const branches = branchOutput
              .split("\n")
              .map((branch) => branch.trim())
              .filter(Boolean);

            const branchCommits: StandupCommit[] = [];
            for (const branch of branches) {
              const log = await runGit(
                ["log", branch, `--since=${since}`, `--until=${until}`, `--format=${GIT_LOG_FORMAT}`],
                cloneDirectory,
              );
              branchCommits.push(
                ...parseBranchLog(log, branch).filter(
                  (commit) =>
                    commit.authorEmail.toLocaleLowerCase() === authorEmail.toLocaleLowerCase() &&
                    isOnLocalDay(commit.committedAt, today),
                ),
              );
            }

            const commits = mergeCommitsByHash(branchCommits);
            for (const [commitIndex, commit] of commits.entries()) {
              setStatus(`Describing ${label} commit ${commitIndex + 1}/${commits.length}…`);
              const diff = await runGit(
                ["show", commit.hash, "--format=", "--stat", "--patch", "--no-ext-diff"],
                cloneDirectory,
              );
              const chunks = chunkDiff(diff);
              const chunkSummaries: string[] = [];
              for (const [chunkIndex, chunk] of chunks.entries()) {
                const response = await complete(
                  options.model,
                  {
                    messages: [
                      {
                        role: "user",
                        content: [
                          {
                            type: "text",
                            text: buildDiffSummaryPrompt(label, commit, chunk, chunkIndex, chunks.length),
                          },
                        ],
                        timestamp: Date.now(),
                      },
                    ],
                  },
                  {
                    apiKey: auth.apiKey,
                    headers: auth.headers,
                    env: auth.env,
                    reasoningEffort: "low",
                  },
                );
                const text = responseText(response);
                chunkSummaries.push(text || "The lower model returned no description for this diff chunk.");
              }
              summaries.push({ repository: label, commit, summary: chunkSummaries.join("\n") });
            }
          }

          if (summaries.length === 0) {
            notify(`No commits by ${authorEmail} were found today on the cloned branches.`, "info");
            return;
          }

          setStatus(`Handing ${summaries.length} commit description(s) to the active model…`);
          pi.sendUserMessage(buildStandupPrompt(authorEmail, today, summaries));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(`Could not create standup: ${message}`, "error");
        } finally {
          setStatus();
          if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
        }
      },
    });
  };
}
