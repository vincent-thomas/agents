import assert from "node:assert/strict";
import { test } from "node:test";
import { createGotoExtension, createGotoWorkspace } from "./goto.ts";
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

test("goto command recovers a queued transition after extension state resets", async () => {
  const created = workspace("feature/parser");
  let tool: any;
  let command: any;
  let followUp: { content: string; options: unknown } | undefined;
  let transition: { workspace: AgentWorkspace; sessionFile: string } | undefined;
  let persisted = false;
  const extension = createGotoExtension({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    dependencies: {
      resolveRepository: repository,
      listWorkspaces: async () => (persisted ? [created] : []),
      createWorkspace: async () => {
        persisted = true;
        return created;
      },
    },
    async transition(workspace, sessionFile) {
      transition = { workspace, sessionFile };
    },
  });
  extension({
    registerTool(definition) {
      tool = definition;
    },
    registerCommand(_name, definition) {
      command = definition;
    },
    sendUserMessage(content, options) {
      followUp = { content: content as string, options };
    },
  } as never);

  const result = await tool.execute("call", { branch: created.branch });
  assert.deepEqual(followUp, {
    content: `/goto-workspace ${created.id}`,
    options: { deliverAs: "followUp" },
  });
  assert.equal(result.terminate, true);

  extension({
    registerTool() {},
    registerCommand(_name, definition) {
      command = definition;
    },
    sendUserMessage() {},
  } as never);

  await command.handler(created.id, {
    waitForIdle: async () => undefined,
    sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
  });
  assert.deepEqual(transition, {
    workspace: created,
    sessionFile: "/sessions/source.jsonl",
  });
});

test("goto command only recovers a matching active workspace", async () => {
  const cases = [
    { ...workspace("feature/parser"), id: "another-workspace" },
    { ...workspace("feature/parser"), status: "completed" as const },
    { ...workspace("feature/parser"), repository: "/other/.git" },
  ];

  for (const candidate of cases) {
    let command: any;
    let transitioned = false;
    const extension = createGotoExtension({
      store: {} as WorkspaceStore,
      cwd: "/repo",
      dependencies: {
        resolveRepository: repository,
        listWorkspaces: async (_store, repositoryPath) => {
          assert.equal(repositoryPath, "/repo/.git");
          return [candidate];
        },
        createWorkspace: async () => {
          throw new Error("must not create");
        },
      },
      async transition() {
        transitioned = true;
      },
    });
    extension({
      registerTool() {},
      registerCommand(_name, definition) {
        command = definition;
      },
    } as never);

    await assert.rejects(
      command.handler("workspace-id", {
        waitForIdle: async () => undefined,
        sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
      }),
      new Error("No matching workspace transition is pending."),
    );
    assert.equal(transitioned, false);
  }
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
