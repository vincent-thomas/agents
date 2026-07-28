import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLaunchMode, selectWorkspace, workspaceLabel } from "./launch.ts";
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

test("parses one explicit launch mode", () => {
  assert.equal(parseLaunchMode([]), "auto");
  assert.equal(parseLaunchMode(["--new"]), "new");
  assert.equal(parseLaunchMode(["-c"]), "continue");
  assert.equal(parseLaunchMode(["--resume"]), "resume");
  assert.throws(() => parseLaunchMode(["--new", "--resume"]), /only one/);
  assert.throws(() => parseLaunchMode(["--unknown"]), /Unknown coder argument/);
});

test("formats a stable user-facing workspace label", () => {
  const record = { ...workspace("one", "2026-01-02T03:04:05.000Z"), sessionName: "Fix parser" };
  assert.equal(workspaceLabel(record), "Fix parser · agent/one · 2026-01-02T03:04:05.000Z");
});

test("resume modes never create a missing task", async () => {
  for (const mode of ["continue", "resume"] as const) {
    await assert.rejects(
      selectWorkspace({
        store: {} as WorkspaceStore,
        cwd: "/repo",
        mode,
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
      /No active agent tasks/,
    );
  }
});

test("interactive selection resumes the chosen active workspace", async () => {
  const records = [
    workspace("newest", "2026-01-02T00:00:00.000Z"),
    workspace("older", "2026-01-01T00:00:00.000Z"),
  ];
  const selected = await selectWorkspace({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    mode: "resume",
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

test("interactive selection creates a workspace only when the user chooses new", async () => {
  const existing = workspace("existing", "2026-01-01T00:00:00.000Z");
  const created = workspace("created", "2026-01-02T00:00:00.000Z");
  const selected = await selectWorkspace({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    mode: "resume",
    choose: async () => "new",
    dependencies: {
      resolveRepository: async () => ({ repository: "/repo/.git", sourceRoot: "/repo", head: "x" }),
      listWorkspaces: async () => [existing],
      createWorkspace: async () => created,
    },
  });
  assert.equal(selected.workspace.id, created.id);
  assert.equal(selected.created, true);
});
