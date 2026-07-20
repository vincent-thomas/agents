import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GIT_LOG_FORMAT,
  buildDiffSummaryPrompt,
  buildStandupPrompt,
  chunkDiff,
  isOnLocalDay,
  mergeCommitsByHash,
  parseBranchLog,
  parseRepositoryArguments,
  repositoryCacheKey,
  repositoryLabel,
} from "./logic.ts";

test("parseRepositoryArguments accepts and deduplicates a JSON string array", () => {
  assert.deepEqual(parseRepositoryArguments('[" git@example.com:a.git ", "https://example.com/b", "git@example.com:a.git"]'), [
    "git@example.com:a.git",
    "https://example.com/b",
  ]);
  assert.throws(() => parseRepositoryArguments("repo-a repo-b"), /JSON array/);
  assert.throws(() => parseRepositoryArguments("[]"), /non-empty JSON array/);
});

test("parseBranchLog parses the delimiter-safe git format", () => {
  assert.match(GIT_LOG_FORMAT, /%cI/);
  const commits = parseBranchLog(
    "abc\u0000Ada\u0000ada@example.com\u00002026-04-01T09:30:00+02:00\u0000Add cache\u001e",
    "feature/cache",
  );
  assert.deepEqual(commits, [
    {
      hash: "abc",
      authorName: "Ada",
      authorEmail: "ada@example.com",
      committedAt: "2026-04-01T09:30:00+02:00",
      subject: "Add cache",
      branches: ["feature/cache"],
    },
  ]);
});

test("mergeCommitsByHash deduplicates commits and retains containing branches", () => {
  const base = {
    hash: "abc",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    committedAt: "2026-04-01T09:30:00+02:00",
    subject: "Add cache",
  };
  assert.deepEqual(mergeCommitsByHash([{ ...base, branches: ["z"] }, { ...base, branches: ["a"] }])[0]?.branches, ["a", "z"]);
});

test("isOnLocalDay compares the timestamp in the machine local timezone", () => {
  const instant = new Date(2026, 3, 1, 12);
  assert.equal(isOnLocalDay(instant.toISOString(), new Date(2026, 3, 1)), true);
  assert.equal(isOnLocalDay(new Date(2026, 3, 2, 12).toISOString(), new Date(2026, 3, 1)), false);
});

test("repositoryLabel handles SSH and HTTPS clone URLs", () => {
  assert.equal(repositoryLabel("git@github.com:org/project.git"), "project");
  assert.equal(repositoryLabel("https://github.com/org/project.git"), "project");
});

test("repositoryCacheKey is stable without exposing clone credentials", () => {
  const repository = "https://token@example.com/org/project.git";
  const key = repositoryCacheKey(repository);
  assert.equal(key, repositoryCacheKey(repository));
  assert.notEqual(key, repositoryCacheKey("https://example.com/org/other.git"));
  assert.doesNotMatch(key, /token|example|project/);
});

test("chunkDiff preserves every character across bounded chunks", () => {
  assert.deepEqual(chunkDiff("abcdefgh", 3), ["abc", "def", "gh"]);
  assert.equal(chunkDiff("", 3)[0], "(empty diff)");
});

test("prompts identify untrusted diffs and provide synthesis evidence", () => {
  const commit = {
    hash: "abc",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    committedAt: "2026-04-01T09:30:00+02:00",
    subject: "Add cache",
    branches: ["feature/cache"],
  };
  assert.match(buildDiffSummaryPrompt("project", commit, "+code", 0, 1), /untrusted data/);
  const prompt = buildStandupPrompt("ada@example.com", new Date(2026, 3, 1), [
    { repository: "project", commit, summary: "Added cache behavior." },
  ]);
  assert.match(prompt, /2026-04-01/);
  assert.match(prompt, /Added cache behavior/);
  assert.match(prompt, /outcome-oriented/);
  assert.match(prompt, /at most five bullets/);
  assert.match(prompt, /Do not add an introduction or conclusion/);
});
