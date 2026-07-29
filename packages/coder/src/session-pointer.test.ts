import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSessionPointerExtension,
  createSessionPointerStore,
  sessionFileExists,
} from "./session-pointer.ts";

test("stores one current session for each checkout", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "session-pointer-"));
  const store = createSessionPointerStore(stateDir);

  try {
    await store.write("/repo/one", "/sessions/one.jsonl");
    await store.write("/repo/two", "/sessions/two.jsonl");

    assert.equal(await store.read("/repo/one"), "/sessions/one.jsonl");
    assert.equal(await store.read("/repo/two"), "/sessions/two.jsonl");
    assert.equal(await store.read("/repo/missing"), undefined);
  } finally {
    await rm(stateDir, { recursive: true });
  }
});

test("removes only the requested current-session pointer", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "session-pointer-remove-"));
  const store = createSessionPointerStore(stateDir);

  try {
    await store.write("/repo/one", "/sessions/one.jsonl");
    await store.write("/repo/two", "/sessions/two.jsonl");

    await store.remove("/repo/one");
    await store.remove("/repo/missing");

    assert.equal(await store.read("/repo/one"), undefined);
    assert.equal(await store.read("/repo/two"), "/sessions/two.jsonl");
  } finally {
    await rm(stateDir, { recursive: true });
  }
});

test("records the replacement session at session start", async () => {
  const writes: Array<[string, string]> = [];
  let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const extension = createSessionPointerExtension({
    read: async () => undefined,
    write: async (cwd, sessionFile) => void writes.push([cwd, sessionFile]),
    remove: async () => undefined,
  });

  extension({
    on(event, handler) {
      if (event === "session_start") sessionStart = handler as never;
    },
  } as never);

  await sessionStart?.(
    {},
    {
      cwd: "/repo",
      sessionManager: { getSessionFile: () => "/sessions/replacement.jsonl" },
    },
  );

  assert.deepEqual(writes, [["/repo", "/sessions/replacement.jsonl"]]);
});

test("recognizes persisted sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-file-"));
  const sessionFile = join(directory, "session.jsonl");

  try {
    assert.equal(await sessionFileExists(sessionFile), false);
    await writeFile(sessionFile, "session\n");
    assert.equal(await sessionFileExists(sessionFile), true);
  } finally {
    await rm(directory, { recursive: true });
  }
});
