import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { MutableAgentSessionRuntimeHost } from "./runtime-host.ts";
import {
  findRecoverableWorkspaceTransition,
  WorkspaceTransitionCoordinator,
} from "./transition.ts";
import type { AgentWorkspace, WorkspaceTransitionMetadata } from "./logic.ts";

function fakeRuntime(name: string, events: string[], cancel = false): AgentSessionRuntime {
  const runner = {
    hasHandlers: () => true,
    async emit(event: { type: string }) {
      events.push(`${name}:${event.type}`);
      return event.type === "session_before_switch" && cancel ? { cancel: true } : undefined;
    },
  };
  const session = {
    sessionFile: `${name}.jsonl`,
    extensionRunner: runner,
    hasExtensionHandlers: () => true,
    dispose() {
      events.push(`${name}:session-dispose`);
    },
  };
  const fake = {
    session,
    services: { cwd: `/${name}` },
    cwd: `/${name}`,
    diagnostics: [],
    modelFallbackMessage: undefined,
    setRebindSession() {},
    setBeforeSessionInvalidate() {},
    async switchSession() {
      return { cancelled: false };
    },
    async newSession() {
      return { cancelled: false };
    },
    async fork() {
      return { cancelled: false };
    },
    async importFromJsonl() {
      return { cancelled: false };
    },
    async dispose() {
      events.push(`${name}:runtime-dispose`);
    },
  };
  return fake as unknown as AgentSessionRuntime;
}

function workspace(branch: string): AgentWorkspace {
  return {
    version: 1,
    id: `${branch}-id`,
    repository: "/repo/.git",
    sourceRoot: "/repo",
    worktree: `/state/${branch}`,
    branch,
    baseSha: "abc123",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    status: "active",
  };
}

function coordinator(options: {
  source: AgentSessionRuntime;
  target?: AgentSessionRuntime;
  persist: WorkspaceTransitionMetadata[];
  order?: string[];
  prepare?: () => Promise<{ runtime: AgentSessionRuntime; sessionFile: string }>;
  create?: () => Promise<AgentWorkspace>;
  update?: (
    current: AgentWorkspace,
    transition: WorkspaceTransitionMetadata,
  ) => Promise<AgentWorkspace>;
  commit?: (prepared: {
    runtime: AgentSessionRuntime;
    sessionFile: string;
  }) => Promise<{ cancelled: boolean }>;
}) {
  const host = new MutableAgentSessionRuntimeHost(options.source);
  return new WorkspaceTransitionCoordinator({
    createWorkspace: async (_branch, sourceSessionFile) => {
      const created = options.create ? await options.create() : workspace("feature/demo");
      const transition = { phase: "pending" as const, sourceSessionFile };
      options.persist.push(transition);
      options.order?.push("persist:pending");
      return { ...created, transition };
    },
    updateTransition: async (current, transition) => {
      options.persist.push(transition);
      options.order?.push(
        `persist:${transition.phase}${transition.targetSessionFile ? ":target" : ""}`,
      );
      return options.update ? options.update(current, transition) : { ...current, transition };
    },
    prepareRuntime:
      options.prepare ??
      (async () => ({
        runtime: options.target ?? fakeRuntime("target", []),
        sessionFile: "target.jsonl",
      })),
    commitRuntime: (_workspace, prepared) =>
      options.commit
        ? options.commit(prepared)
        : host.switchPrepared(prepared.runtime, prepared.sessionFile),
    isRuntimeActive: (runtime) => host.current === runtime,
  });
}

test("successful coordinator transition persists metadata in transactional order and returns the workspace", async () => {
  const events: string[] = [];
  const source = fakeRuntime("source", events);
  const target = fakeRuntime("target", events);
  const created = workspace("feature/demo");
  const persisted: WorkspaceTransitionMetadata[] = [];
  const order: string[] = [];
  const coordinatorInstance = coordinator({
    source,
    target,
    persist: persisted,
    order,
    create: async () => created,
    prepare: async () => {
      order.push("prepare");
      events.push("prepare");
      return { runtime: target, sessionFile: "target.jsonl" };
    },
    commit: async () => {
      events.push("commit");
      return { cancelled: false };
    },
  });

  const result = await coordinatorInstance.create("feature/demo", "source.jsonl");
  assert.deepEqual(result, {
    ...created,
    transition: { phase: "pending", sourceSessionFile: "source.jsonl" },
  });
  assert.equal(coordinatorInstance.state.phase, "pending");
  const switchResult = await coordinatorInstance.switchPending();

  assert.deepEqual(switchResult, { cancelled: false });
  assert.deepEqual(persisted, [
    { phase: "pending", sourceSessionFile: "source.jsonl" },
    { phase: "switching", sourceSessionFile: "source.jsonl" },
    {
      phase: "switching",
      sourceSessionFile: "source.jsonl",
      targetSessionFile: "target.jsonl",
    },
    {
      phase: "active",
      sourceSessionFile: "source.jsonl",
      targetSessionFile: "target.jsonl",
    },
  ]);
  assert.equal(coordinatorInstance.state.phase, "active");
  assert.deepEqual(order, [
    "persist:pending",
    "persist:switching",
    "prepare",
    "persist:switching:target",
    "persist:active:target",
  ]);
  assert.deepEqual(events, ["prepare", "commit"]);
});

test("target preparation failure records failed, leaves the source live, and does not commit", async () => {
  const events: string[] = [];
  const source = fakeRuntime("source", events);
  const persisted: WorkspaceTransitionMetadata[] = [];
  let commitCalled = false;
  const coordinatorInstance = coordinator({
    source,
    persist: persisted,
    prepare: async () => {
      events.push("prepare");
      throw new Error("target could not be prepared");
    },
    commit: async () => {
      commitCalled = true;
      return { cancelled: false };
    },
  });

  await coordinatorInstance.create("feature/broken", "source.jsonl");
  await assert.rejects(coordinatorInstance.switchPending(), /target could not be prepared/);

  assert.equal(commitCalled, false);
  assert.equal(coordinatorInstance.state.phase, "failed");
  assert.equal(coordinatorInstance.state.error, "target could not be prepared");
  assert.deepEqual(persisted, [
    { phase: "pending", sourceSessionFile: "source.jsonl" },
    { phase: "switching", sourceSessionFile: "source.jsonl" },
    {
      phase: "failed",
      sourceSessionFile: "source.jsonl",
      error: "target could not be prepared",
    },
  ]);
  assert.deepEqual(events, ["prepare"]);
});

test("cancellation disposes the prepared runtime and returns metadata to pending", async () => {
  const events: string[] = [];
  const source = fakeRuntime("source", events, true);
  const target = fakeRuntime("target", events);
  const persisted: WorkspaceTransitionMetadata[] = [];
  const coordinatorInstance = coordinator({ source, target, persist: persisted });

  await coordinatorInstance.create("feature/cancelled", "source.jsonl");
  const result = await coordinatorInstance.switchPending();

  assert.deepEqual(result, { cancelled: true });
  assert.equal(coordinatorInstance.state.phase, "pending");
  assert.deepEqual(persisted, [
    { phase: "pending", sourceSessionFile: "source.jsonl" },
    { phase: "switching", sourceSessionFile: "source.jsonl" },
    {
      phase: "switching",
      sourceSessionFile: "source.jsonl",
      targetSessionFile: "target.jsonl",
    },
    { phase: "pending", sourceSessionFile: "source.jsonl" },
  ]);
  assert.deepEqual(events, ["source:session_before_switch", "target:runtime-dispose"]);
});

test("disposes a prepared runtime when metadata persistence fails before commit", async () => {
  const events: string[] = [];
  const source = fakeRuntime("source", events);
  const target = fakeRuntime("target", events);
  const persisted: WorkspaceTransitionMetadata[] = [];
  const coordinatorInstance = coordinator({
    source,
    target,
    persist: persisted,
    update: async (current, transition) => {
      if (transition.phase === "switching" && transition.targetSessionFile) {
        throw new Error("target metadata failed");
      }
      return { ...current, transition };
    },
  });

  await coordinatorInstance.create("feature/metadata-failure", "source.jsonl");
  await assert.rejects(coordinatorInstance.switchPending(), /target metadata failed/);

  assert.equal(coordinatorInstance.state.phase, "failed");
  assert.deepEqual(events, ["target:runtime-dispose"]);
});

test("keeps the adopted target active when final metadata persistence fails", async () => {
  const events: string[] = [];
  const source = fakeRuntime("source", events);
  const target = fakeRuntime("target", events);
  const persisted: WorkspaceTransitionMetadata[] = [];
  const coordinatorInstance = coordinator({
    source,
    target,
    persist: persisted,
    update: async (current, transition) => {
      if (transition.phase === "active") throw new Error("active metadata failed");
      return { ...current, transition };
    },
  });

  await coordinatorInstance.create("feature/active-metadata", "source.jsonl");
  const result = await coordinatorInstance.switchPending();

  assert.deepEqual(result, { cancelled: false });
  assert.equal(coordinatorInstance.state.phase, "active");
  assert.equal(coordinatorInstance.state.workspace?.id, "feature/demo-id");
  assert.deepEqual(events, [
    "source:session_before_switch",
    "source:session_shutdown",
    "source:session-dispose",
  ]);
});

test("create failure reaches an explicit failed state", async () => {
  const source = fakeRuntime("source", []);
  const persisted: WorkspaceTransitionMetadata[] = [];
  const coordinatorInstance = coordinator({
    source,
    persist: persisted,
    create: async () => {
      throw "workspace creation failed";
    },
  });

  await assert.rejects(coordinatorInstance.create("feature/failure", "source.jsonl"));
  assert.deepEqual(coordinatorInstance.state, {
    phase: "failed",
    sourceSessionFile: "source.jsonl",
    error: "workspace creation failed",
  });
  assert.deepEqual(persisted, []);
});

test("findRecoverableWorkspaceTransition selects active pending and switching workspaces only", () => {
  const pending = {
    ...workspace("pending"),
    transition: { phase: "pending" as const, sourceSessionFile: "source.jsonl" },
  };
  const switching = {
    ...workspace("switching"),
    transition: {
      phase: "switching" as const,
      sourceSessionFile: "source.jsonl",
      targetSessionFile: "target.jsonl",
    },
  };

  assert.equal(findRecoverableWorkspaceTransition([pending]), pending);
  assert.equal(findRecoverableWorkspaceTransition([switching]), switching);
  assert.equal(
    findRecoverableWorkspaceTransition([
      { ...pending, status: "completed" as const },
      { ...switching, status: "completed" as const },
      {
        ...workspace("active"),
        transition: { phase: "active" as const, sourceSessionFile: "source.jsonl" },
      },
      {
        ...workspace("failed"),
        transition: {
          phase: "failed" as const,
          sourceSessionFile: "source.jsonl",
          error: "failed",
        },
      },
      workspace("none"),
    ]),
    undefined,
  );
});
