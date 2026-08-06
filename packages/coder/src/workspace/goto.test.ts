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
  const transition = {
    phase: "pending" as const,
    sourceSessionFile: "/sessions/source.jsonl",
  };
  const result = await createGotoWorkspace({
    store: {} as WorkspaceStore,
    cwd: "/repo",
    branch: created.branch,
    transition,
    dependencies: {
      resolveRepository: repository,
      listWorkspaces: async () => [],
      createWorkspace: async (_store, cwd, branch, initial) => {
        assert.equal(cwd, "/repo");
        assert.equal(branch, created.branch);
        assert.deepEqual(initial, { transition });
        return { ...created, ...initial };
      },
    },
  });

  assert.deepEqual(result, { ...created, transition });
});

test("goto creates a transition with the source session and switches after the agent settles", async () => {
  const created = workspace("feature/parser");
  let tool: any;
  let agentSettled: (() => void) | undefined;
  let deferredTransition: (() => Promise<void>) | undefined;
  let scheduled = 0;
  let switchCalls = 0;
  let transitionArguments: { branch: string; sourceSessionFile: string } | undefined;
  const extension = createGotoExtension({
    createTransition: async (branch, sourceSessionFile) => {
      transitionArguments = { branch, sourceSessionFile };
      return created;
    },
    switchPendingTransition: async () => {
      switchCalls += 1;
      return { cancelled: false };
    },
    scheduleTransition(callback) {
      scheduled += 1;
      deferredTransition = callback;
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
  assert.deepEqual(transitionArguments, {
    branch: created.branch,
    sourceSessionFile: "/sessions/source.jsonl",
  });
  assert.equal(scheduled, 0);

  agentSettled!();
  agentSettled!();
  assert.equal(scheduled, 1);
  assert.equal(switchCalls, 0);

  await deferredTransition!();
  assert.equal(switchCalls, 1);
});

test("goto reports a switch failure", async () => {
  const messages: unknown[] = [];
  let tool: any;
  let agentSettled: (() => void) | undefined;
  let deferredTransition: (() => Promise<void>) | undefined;
  const extension = createGotoExtension({
    createTransition: async () => workspace("feature/parser"),
    switchPendingTransition: async () => {
      throw new Error("target session could not be opened");
    },
    scheduleTransition(callback) {
      deferredTransition = callback;
    },
  });
  extension({
    on(event, handler) {
      if (event === "agent_settled") agentSettled = handler as () => void;
    },
    registerTool(definition) {
      tool = definition;
    },
    sendMessage(message) {
      messages.push(message);
    },
  } as never);

  await tool.execute("call", { branch: "feature/parser" }, undefined, undefined, {
    sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
  });
  agentSettled!();
  await deferredTransition!();

  assert.deepEqual(messages, [
    {
      customType: "goto-workspace-error",
      content: "Workspace transition failed: target session could not be opened",
      display: true,
    },
  ]);
});

test("goto rejects an unsaved session before creating a transition", async () => {
  let tool: any;
  let created = false;
  const extension = createGotoExtension({
    createTransition: async () => {
      created = true;
      return workspace("feature/parser");
    },
    switchPendingTransition: async () => ({ cancelled: false }),
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

test("goto rejects an already existing workspace for a non-active stack member", async () => {
  const existing = {
    ...workspace("feature/tip"),
    status: "completed" as const,
    stack: { baseBranch: "main", branches: ["feature/parser", "feature/tip"] },
  };
  await assert.rejects(
    createGotoWorkspace({
      store: {} as WorkspaceStore,
      cwd: "/repo",
      branch: "feature/parser",
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
