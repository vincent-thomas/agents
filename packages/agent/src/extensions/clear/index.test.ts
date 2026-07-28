import assert from "node:assert/strict";
import { test } from "node:test";
import { clearSessionExtension, innerClearSession } from "./index.ts";

test("registers clear at the Pi extension boundary", () => {
  let command: { name: string; description: string | undefined } | undefined;

  clearSessionExtension({
    registerCommand(name, options) {
      command = { name, description: options.description };
    },
  } as never);

  assert.deepEqual(command, {
    name: "clear",
    description: "Start a new session and delete the current one",
  });
});

test("starts a replacement session before deleting the active session", async () => {
  const calls: string[] = [];
  const clearSession = innerClearSession({
    deleteSessionFn: async (sessionFile) => {
      calls.push(`delete:${sessionFile}`);
    },
  });

  await clearSession({
    waitForIdle: async () => calls.push("idle"),
    sessionManager: {
      getSessionFile: () => "/sessions/previous.jsonl",
    },
    newSession: async ({ withSession }: { withSession: (context: unknown) => Promise<void> }) => {
      calls.push("new");
      await withSession({ ui: { notify() {} } });
      return { cancelled: false };
    },
  } as never);

  assert.deepEqual(calls, ["idle", "new", "delete:/sessions/previous.jsonl"]);
});

test("does not delete the active session when replacement is cancelled", async () => {
  const deleted: string[] = [];
  const clearSession = innerClearSession({
    deleteSessionFn: async (sessionFile) => {
      deleted.push(sessionFile);
    },
  });

  await clearSession({
    waitForIdle: async () => {},
    sessionManager: {
      getSessionFile: () => "/sessions/previous.jsonl",
    },
    newSession: async () => ({ cancelled: true }),
  } as never);

  assert.deepEqual(deleted, []);
});

test("reports a deletion failure from the replacement session", async () => {
  const notifications: unknown[][] = [];
  const clearSession = innerClearSession({
    deleteSessionFn: async () => {
      throw new Error("permission denied");
    },
  });

  await clearSession({
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
  } as never);

  assert.deepEqual(notifications, [
    ["Could not delete previous session: permission denied", "error"],
  ]);
});
