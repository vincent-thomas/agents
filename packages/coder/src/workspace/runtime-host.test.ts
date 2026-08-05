import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { MutableAgentSessionRuntimeHost } from "./runtime-host.ts";

function runtime(name: string, events: string[], cancel = false): AgentSessionRuntime {
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
      events.push(`${name}:dispose`);
    },
  };
  const fake = {
    session,
    services: { cwd: `/${name}` },
    cwd: `/${name}`,
    diagnostics: [],
    modelFallbackMessage: undefined,
    setRebindSession(callback?: (session: unknown) => Promise<void>) {
      fake.rebind = callback;
    },
    setBeforeSessionInvalidate(callback?: () => void) {
      fake.beforeInvalidate = callback;
    },
    rebind: undefined as ((session: unknown) => Promise<void>) | undefined,
    beforeInvalidate: undefined as (() => void) | undefined,
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

test("prepared runtime commit has ordered lifecycle and swaps delegates", async () => {
  const events: string[] = [];
  const source = runtime("source", events);
  const target = runtime("target", events);
  const host = new MutableAgentSessionRuntimeHost(source);
  host.setBeforeSessionInvalidate(() => events.push("before-invalidate"));
  host.setRebindSession(async (session) => events.push(`rebind:${session.sessionFile}`));

  const result = await host.switchPrepared(target, "target.jsonl");

  assert.deepEqual(result, { cancelled: false });
  assert.deepEqual(events, [
    "source:session_before_switch",
    "source:session_shutdown",
    "before-invalidate",
    "source:dispose",
    "rebind:target.jsonl",
  ]);
  assert.equal(host.session, target.session);
  assert.equal(host.services, target.services);
  assert.equal(host.cwd, "/target");

  // The retained callbacks are installed on the delegated target as well.
  assert.ok((target as unknown as { rebind: unknown }).rebind);
  assert.ok((target as unknown as { beforeInvalidate: unknown }).beforeInvalidate);
});

test("a cancelled prepared commit preserves the source; prepared runtime disposal belongs to the coordinator", async () => {
  const events: string[] = [];
  const source = runtime("source", events, true);
  const target = runtime("target", events);
  const host = new MutableAgentSessionRuntimeHost(source);

  const result = await host.switchPrepared(target, "target.jsonl");

  assert.deepEqual(result, { cancelled: true });
  assert.deepEqual(events, ["source:session_before_switch"]);
  assert.equal(host.session, source.session);
  assert.equal(host.current, source);
  assert.equal(events.includes("target:runtime-dispose"), false);
});
