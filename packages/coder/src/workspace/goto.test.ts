import assert from "node:assert/strict";
import { test } from "node:test";
import { createGotoWorkspace } from "./goto.ts";
import type { AgentWorkspace, WorkspaceStore } from "./logic.ts";

function workspace(branch: string): AgentWorkspace {
  return {
    version: 1,
    id: "workspace-id",
    repository: "/repo/.git",
    sourceRoot: "/repo",
    worktree: "/state/worktree",
    branch,
    baseSha: "abc123",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    status: "active",
  };
}

const repository = async () => ({
  repository: "/repo/.git",
  sourceRoot: "/repo",
  head: "abc123",
});

test("goto creates a workspace for a new branch", async () => {
  const created = workspace("feature/parser");
  const result = await createGotoWorkspace({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    branch: created.branch,
    dependencies: {
      resolveRepository: repository,
      listWorkspaces: async () => [],
      createWorkspace: async (_store, cwd, branch) => {
        assert.equal(cwd, "/repo");
        assert.equal(branch, created.branch);
        return created;
      },
    },
  });

  assert.equal(result, created);
});

test("goto rejects an already existing workspace", async () => {
  const existing = { ...workspace("feature/parser"), status: "completed" as const };
  await assert.rejects(
    createGotoWorkspace({
      store: {} as WorkspaceStore,
      cwd: "/repo",
      branch: existing.branch,
      dependencies: {
        resolveRepository: repository,
        listWorkspaces: async () => [existing],
        createWorkspace: async () => {
          throw new Error("must not create");
        },
      },
    }),
    new Error("A workspace already exists for branch feature/parser."),
  );
});
