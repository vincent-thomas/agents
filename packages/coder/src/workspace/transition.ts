import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AgentWorkspace,
  WorkspaceTransitionMetadata,
  WorkspaceTransitionPhase,
} from "./logic.ts";

export type WorkspaceTransitionState =
  | { phase: "active"; workspace?: AgentWorkspace }
  | { phase: "creating"; branch: string; sourceSessionFile: string }
  | {
      phase: "pending" | "switching";
      workspace: AgentWorkspace;
      sourceSessionFile: string;
      targetSessionFile?: string;
    }
  | {
      phase: "failed";
      workspace?: AgentWorkspace;
      sourceSessionFile: string;
      targetSessionFile?: string;
      error: string;
    };

export interface PreparedWorkspaceRuntime {
  runtime: AgentSessionRuntime;
  sessionFile: string;
}

export interface WorkspaceTransitionCoordinatorOptions {
  initialWorkspace?: AgentWorkspace;
  createWorkspace: (branch: string) => Promise<AgentWorkspace>;
  updateTransition: (
    workspace: AgentWorkspace,
    transition: WorkspaceTransitionMetadata,
  ) => Promise<AgentWorkspace>;
  prepareRuntime: (
    workspace: AgentWorkspace,
    sourceSessionFile: string,
  ) => Promise<PreparedWorkspaceRuntime>;
  commitRuntime: (
    workspace: AgentWorkspace,
    prepared: PreparedWorkspaceRuntime,
  ) => Promise<{ cancelled: boolean }>;
}

export function normalizeTransitionError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function metadata(
  phase: WorkspaceTransitionPhase,
  sourceSessionFile: string,
  targetSessionFile?: string,
  error?: string,
): WorkspaceTransitionMetadata {
  return {
    phase,
    sourceSessionFile,
    ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
    ...(error === undefined ? {} : { error }),
  };
}

/** Coordinates workspace creation and the two-phase runtime replacement. */
export class WorkspaceTransitionCoordinator {
  private currentState: WorkspaceTransitionState;
  private switchFlight?: Promise<{ cancelled: boolean }>;

  constructor(private readonly options: WorkspaceTransitionCoordinatorOptions) {
    this.currentState = { phase: "active", workspace: options.initialWorkspace };
  }

  get state(): WorkspaceTransitionState {
    return this.currentState;
  }

  async create(branch: string, sourceSessionFile: string): Promise<AgentWorkspace> {
    if (this.currentState.phase !== "active" && this.currentState.phase !== "failed") {
      throw new Error("A workspace transition is already in progress.");
    }

    this.currentState = { phase: "creating", branch, sourceSessionFile };
    let workspace: AgentWorkspace | undefined;
    try {
      workspace = await this.options.createWorkspace(branch);
      workspace = await this.options.updateTransition(
        workspace,
        metadata("pending", sourceSessionFile),
      );
      this.currentState = { phase: "pending", workspace, sourceSessionFile };
      return workspace;
    } catch (error) {
      await this.fail(workspace, sourceSessionFile, undefined, error);
      throw error;
    }
  }

  switchPending(): Promise<{ cancelled: boolean }> {
    if (this.switchFlight) return this.switchFlight;
    const flight = this.runSwitchPending();
    this.switchFlight = flight.finally(() => {
      this.switchFlight = undefined;
    });
    return this.switchFlight;
  }

  private async runSwitchPending(): Promise<{ cancelled: boolean }> {
    if (this.currentState.phase !== "pending") {
      throw new Error("No pending workspace transition.");
    }

    const pending = this.currentState;
    let workspace = pending.workspace;
    try {
      workspace = await this.options.updateTransition(
        workspace,
        metadata("switching", pending.sourceSessionFile),
      );
      this.currentState = {
        phase: "switching",
        workspace,
        sourceSessionFile: pending.sourceSessionFile,
      };

      const prepared = await this.options.prepareRuntime(workspace, pending.sourceSessionFile);
      workspace = await this.options.updateTransition(
        workspace,
        metadata("switching", pending.sourceSessionFile, prepared.sessionFile),
      );
      this.currentState = {
        phase: "switching",
        workspace,
        sourceSessionFile: pending.sourceSessionFile,
        targetSessionFile: prepared.sessionFile,
      };

      const result = await this.options.commitRuntime(workspace, prepared);
      if (result.cancelled) {
        await prepared.runtime.dispose();
        workspace = await this.options.updateTransition(
          workspace,
          metadata("pending", pending.sourceSessionFile),
        );
        this.currentState = {
          phase: "pending",
          workspace,
          sourceSessionFile: pending.sourceSessionFile,
        };
        return result;
      }

      workspace = await this.options.updateTransition(
        workspace,
        metadata("active", pending.sourceSessionFile, prepared.sessionFile),
      );
      this.currentState = { phase: "active", workspace };
      return result;
    } catch (error) {
      const targetSessionFile =
        this.currentState.phase === "switching" ? this.currentState.targetSessionFile : undefined;
      await this.fail(workspace, pending.sourceSessionFile, targetSessionFile, error);
      throw error;
    }
  }

  private async fail(
    workspace: AgentWorkspace | undefined,
    sourceSessionFile: string,
    targetSessionFile: string | undefined,
    error: unknown,
  ): Promise<void> {
    const message = normalizeTransitionError(error);
    let updatedWorkspace = workspace;
    if (workspace) {
      try {
        updatedWorkspace = await this.options.updateTransition(
          workspace,
          metadata("failed", sourceSessionFile, targetSessionFile, message),
        );
      } catch {
        // Keep the original transition failure as the actionable error.
      }
    }
    this.currentState = {
      phase: "failed",
      ...(updatedWorkspace === undefined ? {} : { workspace: updatedWorkspace }),
      sourceSessionFile,
      ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
      error: message,
    };
  }
}

export function findRecoverableWorkspaceTransition(
  workspaces: readonly AgentWorkspace[],
): AgentWorkspace | undefined {
  return workspaces.find(
    (workspace) =>
      workspace.status === "active" &&
      (workspace.transition?.phase === "pending" || workspace.transition?.phase === "switching"),
  );
}
