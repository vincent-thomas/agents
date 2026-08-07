import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDescribedStackPullRequests,
  ensureManagedPullRequestDescriptions,
  managedDescriptionSha,
  managedPullRequestDescription,
  refreshManagedPullRequestDescription,
  stripGitHubStackBoilerplate,
  type PullRequestDescription,
} from "./pr-descriptions.ts";
import type { GhStackCommandRunner } from "./github-stack.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pr-descriptions-"));
  git(cwd, ["init", "--initial-branch", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  writeFileSync(join(cwd, "file.txt"), "base\n");
  git(cwd, ["add", "file.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["switch", "-c", "feature"]);
  writeFileSync(join(cwd, "file.txt"), "feature\n");
  git(cwd, ["commit", "-am", "feature"]);
  return cwd;
}

const description = (body: string): PullRequestDescription => ({
  branch: "feature",
  title: "Feature title",
  body,
});

test("creates a new draft PR with the authored SHA-bound body", async () => {
  const cwd = repository();
  try {
    let command: readonly string[] = [];
    const runner: GhStackCommandRunner = async (args) => {
      command = args;
      return { stdout: "https://github.example/pr/1", stderr: "" };
    };

    const result = await createDescribedStackPullRequests(
      cwd,
      ["feature"],
      "main",
      [description("## Context\n\nA reviewer-oriented explanation.")],
      undefined,
      runner,
    );

    assert.equal(result.success, true);
    assert.deepEqual(command.slice(0, 4), ["pr", "create", "--draft", "--title"]);
    assert.equal(command[command.indexOf("--head") + 1], "feature");
    assert.equal(command[command.indexOf("--base") + 1], "main");
    const body = command[command.indexOf("--body") + 1] ?? "";
    assert.match(body, /reviewer-oriented explanation/);
    assert.equal(managedDescriptionSha(body, "feature"), git(cwd, ["rev-parse", "feature"]));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("refreshes only the bounded SHA section and preserves authored surroundings", () => {
  const old = managedPullRequestDescription(description("old details"), "old-sha");
  const stackBoilerplate =
    "Stack created with [GitHub Stacks CLI](https://github.com/github/gh-stack) • [Give Feedback 💬](https://github.com/github/gh-stack/issues)";
  const existing = `${stackBoilerplate}\n\nhuman introduction\n\n${old}\n\nreview notes`;
  const refreshed = refreshManagedPullRequestDescription(
    existing,
    description("new details"),
    "new-sha",
  );
  assert.match(refreshed, /human introduction/);
  assert.match(refreshed, /review notes/);
  assert.doesNotMatch(refreshed, /Stack created with/);
  assert.equal(stripGitHubStackBoilerplate(stackBoilerplate), "");
  assert.match(refreshed, /new details/);
  assert.doesNotMatch(refreshed, /old details/);
  assert.equal(managedDescriptionSha(refreshed, "feature"), "new-sha");
});

test("preserves a current marker for CI-only retries and reports stale content", async () => {
  const cwd = repository();
  try {
    const sha = git(cwd, ["rev-parse", "feature"]);
    let body = managedPullRequestDescription(description("current"), sha);
    const edits: string[] = [];
    const runner: GhStackCommandRunner = async (args) => {
      if (args[1] === "view") {
        return {
          stdout: JSON.stringify({ number: 1, title: "Feature title", body }),
          stderr: "",
        };
      }
      edits.push(args.join(" "));
      body = args[args.indexOf("--body") + 1] as string;
      return { stdout: "", stderr: "" };
    };

    const retry = await ensureManagedPullRequestDescriptions(
      cwd,
      ["feature"],
      [],
      undefined,
      runner,
    );
    assert.equal(retry.success, true);
    assert.deepEqual(retry.preserved, ["feature"]);
    assert.equal(edits.length, 0);

    body =
      "Stack created with [GitHub Stacks CLI](https://github.com/github/gh-stack) • [Give Feedback 💬](https://github.com/github/gh-stack/issues)\n\n" +
      body;
    const cleaned = await ensureManagedPullRequestDescriptions(
      cwd,
      ["feature"],
      [],
      undefined,
      runner,
    );
    assert.deepEqual(cleaned.updated, ["feature"]);
    assert.doesNotMatch(body, /Stack created with/);

    writeFileSync(join(cwd, "file.txt"), "changed\n");
    git(cwd, ["commit", "-am", "changed"]);
    const stale = await ensureManagedPullRequestDescriptions(
      cwd,
      ["feature"],
      [],
      undefined,
      runner,
    );
    assert.equal(stale.success, false);
    assert.equal(stale.issues[0]?.stage, "validate");
    assert.match(stale.issues[0]?.error ?? "", /stale/);

    const refreshed = await ensureManagedPullRequestDescriptions(
      cwd,
      ["feature"],
      [description("updated details")],
      undefined,
      runner,
    );
    assert.equal(refreshed.success, true);
    assert.equal(refreshed.updated[0], "feature");
    assert.match(body, /updated details/);
    assert.ok(edits.some((edit) => edit.includes("--title Feature title")));

    const updateFailure: GhStackCommandRunner = async (args) => {
      if (args[1] === "view") {
        return {
          stdout: JSON.stringify({ number: 1, title: "Feature title", body }),
          stderr: "",
        };
      }
      throw new Error("GitHub refused the edit");
    };
    const failed = await ensureManagedPullRequestDescriptions(
      cwd,
      ["feature"],
      [description("another revision")],
      undefined,
      updateFailure,
    );
    assert.equal(failed.success, false);
    assert.equal(failed.issues[0]?.stage, "update");
    assert.match(failed.issues[0]?.error ?? "", /GitHub refused/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
