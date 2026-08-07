import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeConflictWriteGuardExtension } from "./merge-conflict-write-guard/index.ts";
import { createExtensionProfiles } from "./profiles.ts";

type RegisteredTool = {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string },
  ): Promise<unknown>;
};

test("composes ordered subagent extensions with workspace enforcement", async () => {
  const workspaceError = new Error("outside workspace");
  const profiles = createExtensionProfiles({
    async assertWorkspace() {
      throw workspaceError;
    },
  });

  assert.equal(profiles.safetyExtensions.length, 2);
  assert.equal(profiles.safetyExtensions[0], mergeConflictWriteGuardExtension);
  assert.equal(profiles.workspaceExtensions.length, 2);
  assert.deepEqual(profiles.subagentExtensions, [
    profiles.safetyExtensions[0],
    profiles.safetyExtensions[1],
    profiles.workspaceExtensions[0],
    profiles.workspaceExtensions[1],
  ]);

  const eventNames: string[] = [];
  const tools: RegisteredTool[] = [];
  const pi = {
    on(eventName: string) {
      eventNames.push(eventName);
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  };

  for (const extension of profiles.subagentExtensions) {
    extension(pi as never);
  }

  assert.deepEqual(eventNames, ["tool_call", "tool_call"]);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "git_commit",
      "create_github_stack",
      "inspect_stack",
      "checkout_stack_branch",
      "push_and_check_ci",
    ],
  );

  await assert.rejects(
    tools[0]!.execute(
      "commit-call",
      { subject: "Test", what: "Test", why: "Test", add_all: false },
      undefined,
      undefined,
      { cwd: "/repo" },
    ),
    (error) => error === workspaceError,
  );
  await assert.rejects(
    tools[1]!.execute("stack-call", { branches: ["feature"] }, undefined, undefined, {
      cwd: "/repo",
    }),
    (error) => error === workspaceError,
  );
  await assert.rejects(
    tools[2]!.execute("inspect-call", {}, undefined, undefined, { cwd: "/repo" }),
    (error) => error === workspaceError,
  );
  await assert.rejects(
    tools[3]!.execute("checkout-call", { target: "feature" }, undefined, undefined, {
      cwd: "/repo",
    }),
    (error) => error === workspaceError,
  );
  await assert.rejects(
    tools[4]!.execute("push-call", {}, undefined, undefined, { cwd: "/repo" }),
    (error) => error === workspaceError,
  );
});
