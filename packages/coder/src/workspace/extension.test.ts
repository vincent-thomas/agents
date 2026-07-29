import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceStartupNotice } from "./extension.ts";
import type { AgentWorkspace } from "./logic.ts";

function workspace(branchSetup: AgentWorkspace["branchSetup"]): AgentWorkspace {
  return {
    version: 1,
    id: "workspace-id",
    repository: "/repo/.git",
    sourceRoot: "/repo",
    worktree: "/state/worktree",
    branch: "feature/parser",
    baseSha: "abc123",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    status: "active",
    branchSetup,
  };
}

test("reports reuse of an existing local branch", () => {
  assert.equal(
    workspaceStartupNotice(workspace("reused-local"), true),
    "Reused existing local branch feature/parser.\n" +
      "Created agent workspace feature/parser\n" +
      "/state/worktree",
  );
});

test("reports fetching a remote branch and creating its tracking branch", () => {
  assert.equal(
    workspaceStartupNotice(workspace("fetched-origin"), true),
    "Fetched origin/feature/parser and created a local tracking branch.\n" +
      "Created agent workspace feature/parser\n" +
      "/state/worktree",
  );
});
