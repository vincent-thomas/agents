export interface RLMChildHandle {
  /** Stable host-side identity for this admitted child. */
  readonly id: number;
  readonly name: string;
  readonly parentRunId: number;
  readonly depth: number;
}

export type RLMChildStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface RLMChildError {
  readonly name: string;
  readonly message: string;
}

/** A JSON-safe snapshot of one admitted child. */
export interface RLMChildResult {
  readonly handle: RLMChildHandle;
  readonly status: RLMChildStatus;
  readonly text?: string;
  readonly error?: RLMChildError;
}
