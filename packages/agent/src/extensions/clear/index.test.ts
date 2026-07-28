import assert from "node:assert/strict";
import { test } from "node:test";
import { createClearExtension } from "./index.ts";

type CommandHandler = (args: string, context: any) => Promise<void>;

function setup(deleteSession: (sessionFile: string) => Promise<void>) {
  let handler: CommandHandler | undefined;

  createClearExtension({ deleteSession })({
    registerCommand(name, command) {
      assert.equal(name, "clear");
      assert.equal(command.description, "Start a new session and delete the current one");
      handler = command.handler as CommandHandler;
    },
  } as never);

  assert.ok(handler);
  return handler;
}

test("starts a replacement session before deleting the active session", async () => {
  const calls: string[] = [];
  const handler = setup(async (sessionFile) => {
    calls.push(`delete:${sessionFile}`);
  });

  await handler("", {
    waitForIdle: async () => calls.push("idle"),
    sessionManager: {
      getSessionFile: () => "/sessions/previous.jsonl",
    },
    newSession: async ({ withSession }: { withSession: (context: unknown) => Promise<void> }) => {
      calls.push("new");
      await withSession({ ui: { notify() {} } });
      return { cancelled: false };
    },
  });

  assert.deepEqual(calls, ["idle", "new", "delete:/sessions/previous.jsonl"]);
});

test("does not delete the active session when replacement is cancelled", async () => {
  const deleted: string[] = [];
  const handler = setup(async (sessionFile) => {
    deleted.push(sessionFile);
  });

  await handler("", {
    waitForIdle: async () => {},
    sessionManager: {
      getSessionFile: () => "/sessions/previous.jsonl",
    },
    newSession: async () => ({ cancelled: true }),
  });

  assert.deepEqual(deleted, []);
});

test("reports a deletion failure from the replacement session", async () => {
  const notifications: unknown[][] = [];
  const handler = setup(async () => {
    throw new Error("permission denied");
  });

  await handler("", {
    waitForIdle: async () => {},
    sessionManager: {
      getSessionFile: () => "/sessions/previous.jsonl",
    },
    newSession: async ({ withSession }: { withSession: (context: unknown) => Promise<void> }) => {
      await withSession({
        ui: {
          notify(...args: unknown[]) {
            notifications.push(args);
          },
        },
      });
      return { cancelled: false };
    },
  });

  assert.deepEqual(notifications, [
    ["Could not delete previous session: permission denied", "error"],
  ]);
});
