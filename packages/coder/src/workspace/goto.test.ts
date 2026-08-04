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

test("goto tool moves the current session after the agent settles", async () => {
  const created = workspace("feature/parser");
  let tool: any;
  let agentSettled: (() => void) | undefined;
  let deferredTransition: (() => Promise<void>) | undefined;
  let scheduled = 0;
  let transition: { workspace: AgentWorkspace; sessionFile: string } | undefined;
  const extension = createGotoExtension({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    dependencies: {
      resolveRepository: repository,
      listWorkspaces: async () => [],
      createWorkspace: async () => created,
    },
    scheduleTransition(callback) {
      scheduled += 1;
      deferredTransition = callback;
    },
    async transition(workspace, sessionFile) {
      transition = { workspace, sessionFile };
    },
  });
  extension({
    on(event, handler) {
      if (event === "agent_settled") agentSettled = handler as () => void;
    },
    registerTool(definition) {
      tool = definition;
    },
  } as never);

  const result = await tool.execute("call", { branch: created.branch }, undefined, undefined, {
    sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
  });
  assert.equal(result.terminate, true);
  assert.equal(transition, undefined);
  await assert.rejects(
    tool.execute("second-call", { branch: "feature/other" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
    }),
    new Error("A workspace transition is already pending."),
  );

  agentSettled!();
  agentSettled!();
  assert.equal(scheduled, 1);
  assert.equal(transition, undefined);

  await deferredTransition!();
  assert.deepEqual(transition, {
    workspace: created,
    sessionFile: "/sessions/source.jsonl",
  });
});

test("goto rejects an unsaved session before creating a workspace", async () => {
  let tool: any;
  let created = false;
  const extension = createGotoExtension({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    dependencies: {
      resolveRepository: repository,
      listWorkspaces: async () => [],
      createWorkspace: async () => {
        created = true;
        return workspace("feature/parser");
      },
    },
    async transition() {},
  });
  extension({
    on() {},
    registerTool(definition) {
      tool = definition;
    },
  } as never);

  await assert.rejects(
    tool.execute("call", { branch: "feature/parser" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => undefined },
    }),
    new Error("The current session has not been saved yet."),
  );
  assert.equal(created, false);
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
