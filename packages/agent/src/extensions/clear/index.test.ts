import assert from "node:assert/strict";
import { test } from "node:test";
import { clearExtension, clearSession } from "./index.ts";

test("registers clear at the Pi extension boundary", () => {
  let command: { name: string; description: string | undefined } | undefined;

  clearExtension({
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
  const deleteSession = async (sessionFile: string) => {
    calls.push(`delete:${sessionFile}`);
  };

  await clearSession(
    {
      waitForIdle: async () => calls.push("idle"),
      sessionManager: {
        getSessionFile: () => "/sessions/previous.jsonl",
      },
      newSession: async ({ withSession }: { withSession: (context: unknown) => Promise<void> }) => {
        calls.push("new");
        await withSession({ ui: { notify() {} } });
        return { cancelled: false };
      },
    } as never,
    deleteSession,
  );

  assert.deepEqual(calls, ["idle", "new", "delete:/sessions/previous.jsonl"]);
});

test("does not delete the active session when replacement is cancelled", async () => {
  const deleted: string[] = [];
  const deleteSession = async (sessionFile: string) => {
    deleted.push(sessionFile);
  };

  await clearSession(
    {
      waitForIdle: async () => {},
      sessionManager: {
        getSessionFile: () => "/sessions/previous.jsonl",
      },
      newSession: async () => ({ cancelled: true }),
    } as never,
    deleteSession,
  );

  assert.deepEqual(deleted, []);
});

test("reports a deletion failure from the replacement session", async () => {
  const notifications: unknown[][] = [];
  const deleteSession = async () => {
    throw new Error("permission denied");
  };

  await clearSession(
    {
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
    } as never,
    deleteSession,
  );

  assert.deepEqual(notifications, [
    ["Could not delete previous session: permission denied", "error"],
  ]);
});
