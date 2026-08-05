import type {
  AgentSessionRuntime,
  AgentSessionRuntimeDiagnostic,
  AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { AgentSessionRuntime as AgentSessionRuntimeClass } from "@earendil-works/pi-coding-agent";

/** A runtime which has been created but has not yet been made current. */
export type PreparedAgentSessionRuntime = AgentSessionRuntime;

export interface PreparedRuntimeSwitchResult {
  cancelled: boolean;
}

/**
 * A stable runtime host for modes which keep references to the runtime while a
 * session is replaced.  The SDK runtime is deliberately kept behind this
 * object: replacing a session therefore does not replace the object owned by
 * InteractiveMode.
 */
export class MutableAgentSessionRuntimeHost extends AgentSessionRuntimeClass {
  private currentRuntime: AgentSessionRuntime;
  private hostRebindSession?: (session: AgentSessionRuntime["session"]) => Promise<void>;
  private hostBeforeSessionInvalidate?: () => void;

  constructor(runtime: AgentSessionRuntime) {
    // AgentSessionRuntime has a public constructor but its factory is private
    // state.  Every operation which could use that factory is overridden below;
    // this inert factory exists only for the SDK's structural base class.
    super(
      runtime.session,
      runtime.services,
      async () => {
        throw new Error("MutableAgentSessionRuntimeHost does not create runtimes.");
      },
      [...runtime.diagnostics],
      runtime.modelFallbackMessage,
    );
    this.currentRuntime = runtime;
  }

  override get session(): AgentSessionRuntime["session"] {
    return this.currentRuntime.session;
  }

  override get services(): AgentSessionServices {
    return this.currentRuntime.services;
  }

  override get cwd(): string {
    return this.currentRuntime.cwd;
  }

  override get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
    return this.currentRuntime.diagnostics;
  }

  override get modelFallbackMessage(): string | undefined {
    return this.currentRuntime.modelFallbackMessage;
  }

  override setRebindSession(
    rebindSession?: (session: AgentSessionRuntime["session"]) => Promise<void>,
  ): void {
    this.hostRebindSession = rebindSession;
    this.currentRuntime.setRebindSession(rebindSession);
  }

  override setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
    this.hostBeforeSessionInvalidate = beforeSessionInvalidate;
    this.currentRuntime.setBeforeSessionInvalidate(beforeSessionInvalidate);
  }

  private installCallbacks(runtime: AgentSessionRuntime): void {
    runtime.setRebindSession(this.hostRebindSession);
    runtime.setBeforeSessionInvalidate(this.hostBeforeSessionInvalidate);
  }

  override switchSession(
    sessionPath: string,
    options?: Parameters<AgentSessionRuntime["switchSession"]>[1],
  ): ReturnType<AgentSessionRuntime["switchSession"]> {
    return this.currentRuntime.switchSession(sessionPath, options);
  }

  override newSession(
    options?: Parameters<AgentSessionRuntime["newSession"]>[0],
  ): ReturnType<AgentSessionRuntime["newSession"]> {
    return this.currentRuntime.newSession(options);
  }

  override fork(
    entryId: string,
    options?: Parameters<AgentSessionRuntime["fork"]>[1],
  ): ReturnType<AgentSessionRuntime["fork"]> {
    return this.currentRuntime.fork(entryId, options);
  }

  override importFromJsonl(
    inputPath: string,
    cwdOverride?: string,
  ): ReturnType<AgentSessionRuntime["importFromJsonl"]> {
    return this.currentRuntime.importFromJsonl(inputPath, cwdOverride);
  }

  override dispose(): ReturnType<AgentSessionRuntime["dispose"]> {
    return this.currentRuntime.dispose();
  }

  /**
   * Commit an already-created runtime without exposing a half-switched host.
   * Preparation is intentionally not part of this method, so failures during
   * preparation cannot tear down the current session.
   */
  async switchPrepared(
    targetRuntime: PreparedAgentSessionRuntime,
    targetSessionFile: string,
  ): Promise<PreparedRuntimeSwitchResult> {
    const sourceRuntime = this.currentRuntime;
    const sourceRunner = sourceRuntime.session.extensionRunner;

    if (sourceRunner.hasHandlers("session_before_switch")) {
      const result = await sourceRunner.emit({
        type: "session_before_switch",
        reason: "resume",
        targetSessionFile,
      });
      if (result?.cancel === true) return { cancelled: true };
    }

    await sourceRunner.emit({
      type: "session_shutdown",
      reason: "resume",
      targetSessionFile,
    });
    this.hostBeforeSessionInvalidate?.();
    sourceRuntime.session.dispose();

    this.currentRuntime = targetRuntime;
    this.installCallbacks(targetRuntime);
    if (this.hostRebindSession) await this.hostRebindSession(targetRuntime.session);
    return { cancelled: false };
  }

  /** The target runtime currently held by the host. */
  get current(): AgentSessionRuntime {
    return this.currentRuntime;
  }
}
