import assert from "node:assert/strict";
import { test } from "node:test";
import { LaunchError, parseLaunchCommand, selectWorkspace, workspaceLabel } from "./launch.ts";
import type { AgentWorkspace, WorkspaceStore } from "./logic.ts";

function workspace(id: string, updatedAt: string): AgentWorkspace {
  return {
    version: 1,
    id,
    repository: "/repo/.git",
    sourceRoot: "/repo",
    worktree: `/state/${id}`,
    branch: `agent/${id}`,
    baseSha: "abc123",
    createdAt: updatedAt,
    updatedAt,
    status: "active",
  };
}

test("parses regular and goto launches", () => {
  assert.deepEqual(parseLaunchCommand([]), { kind: "regular" });
  assert.deepEqual(parseLaunchCommand(["goto"]), { kind: "goto" });
  assert.deepEqual(parseLaunchCommand(["goto", "feature/parser"]), {
    kind: "goto",
    branch: "feature/parser",
  });
  assert.throws(
    () => parseLaunchCommand(["--resume"]),
    (error) =>
      error instanceof LaunchError && error.message === "Usage: coder [goto [branch-name]]",
  );
  assert.throws(() => parseLaunchCommand(["goto", "one", "two"]), LaunchError);
});

test("formats a stable user-facing workspace label", () => {
  const record = { ...workspace("one", "2026-01-02T03:04:05.000Z"), sessionName: "Fix parser" };
  assert.equal(workspaceLabel(record), "Fix parser · agent/one · 2026-01-02T03:04:05.000Z");
});

test("goto without a branch rejects when no active workspace exists", async () => {
  await assert.rejects(
    selectWorkspace({
      store: {} as WorkspaceStore,
      cwd: "/repo",
      dependencies: {
        resolveRepository: async () => ({
          repository: "/repo/.git",
          sourceRoot: "/repo",
          head: "x",
        }),
        listWorkspaces: async () => [],
        createWorkspace: async () => {
          throw new Error("must not create");
        },
      },
    }),
    (error) =>
      error instanceof LaunchError &&
      error.message ===
        "No active agent workspaces exist. Create one with coder goto <branch-name>.",
  );
});

test("interactive selection resumes the chosen active workspace", async () => {
  const records = [
    workspace("newest", "2026-01-02T00:00:00.000Z"),
    workspace("older", "2026-01-01T00:00:00.000Z"),
  ];
  const selected = await selectWorkspace({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    choose: async (options) => options[1]!,
    dependencies: {
      resolveRepository: async () => ({ repository: "/repo/.git", sourceRoot: "/repo", head: "x" }),
      listWorkspaces: async () => records,
      createWorkspace: async () => {
        throw new Error("must not create");
      },
    },
  });
  assert.equal(selected.workspace.id, records[1]?.id);
  assert.equal(selected.created, false);
});

test("goto with a branch resumes its active workspace", async () => {
  const existing = {
    ...workspace("existing", "2026-01-02T00:00:00.000Z"),
    branch: "feature/parser",
  };
  const selected = await selectWorkspace({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    branch: "feature/parser",
    dependencies: {
      resolveRepository: async () => ({ repository: "/repo/.git", sourceRoot: "/repo", head: "x" }),
      listWorkspaces: async () => [existing],
      createWorkspace: async () => {
        throw new Error("must not create");
      },
    },
  });
  assert.equal(selected.workspace.id, existing.id);
  assert.equal(selected.created, false);
});

test("goto with an unregistered branch creates a workspace", async () => {
  const created = workspace("created", "2026-01-02T00:00:00.000Z");
  const selected = await selectWorkspace({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    branch: "feature/parser",
    dependencies: {
      resolveRepository: async () => ({ repository: "/repo/.git", sourceRoot: "/repo", head: "x" }),
      listWorkspaces: async () => [],
      createWorkspace: async (_store, _cwd, branch) => {
        assert.equal(branch, "feature/parser");
        return created;
      },
    },
  });
  assert.equal(selected.workspace.id, created.id);
  assert.equal(selected.created, true);
});
