import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceExtension, workspaceStartupNotice } from "./extension.ts";
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

test("instructs the agent how to materialize independently valid stacked PRs", async () => {
  let beforeAgentStart: any;
  const extension = createWorkspaceExtension({
    store: {} as never,
    initialWorkspace: workspace("created"),
    created: true,
    dependencies: {
      assertOwnedWorkspace: async () => undefined,
      loadWorkspace: async () => workspace("created"),
      updateWorkspace: async (_store, current) => current,
    },
  });
  extension({
    on(event, handler) {
      if (event === "before_agent_start") beforeAgentStart = handler;
    },
    registerCommand() {},
  } as never);

  const result = await beforeAgentStart({ systemPrompt: "base prompt" });

  assert.match(result.systemPrompt, /each PR boundary an independently valid commit/);
  assert.match(result.systemPrompt, /branch_points ordered base-to-tip/);
  assert.match(result.systemPrompt, /owned workspace branch must be the final stack branch/);
});

test("persists session metadata against the latest transition record", async () => {
  const initial = {
    ...workspace("created"),
    transition: {
      phase: "switching" as const,
      sourceSessionFile: "/sessions/source.jsonl",
    },
  };
  const latest = {
    ...initial,
    transition: {
      phase: "active" as const,
      sourceSessionFile: "/sessions/source.jsonl",
      targetSessionFile: "/sessions/target.jsonl",
    },
  };
  let sessionInfoChanged: any;
  let updateBase: AgentWorkspace | undefined;
  const extension = createWorkspaceExtension({
    store: {} as never,
    initialWorkspace: initial,
    created: false,
    dependencies: {
      assertOwnedWorkspace: async () => undefined,
      loadWorkspace: async () => latest,
      updateWorkspace: async (_store, current, patch) => {
        updateBase = current;
        return { ...current, ...patch, updatedAt: "2026-01-02T03:05:00.000Z" };
      },
    },
  });
  extension({
    on(event, handler) {
      if (event === "session_info_changed") sessionInfoChanged = handler;
    },
    registerCommand() {},
  } as never);

  await sessionInfoChanged(
    { name: "Transactional transition" },
    {
      sessionManager: { getSessionFile: () => "/sessions/target.jsonl" },
      ui: { setStatus() {} },
    },
  );

  assert.equal(updateBase, latest);
  assert.deepEqual(initial.transition, latest.transition);
  assert.equal(initial.sessionName, "Transactional transition");
});
