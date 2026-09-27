import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunState } from "./types.ts";

export interface StateStore {
  load(runId: string): Promise<RunState>;
  save(state: RunState): Promise<void>;
}

export class JsonStateStore implements StateStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async load(runId: string): Promise<RunState> {
    const state = JSON.parse(
      await readFile(join(this.directory, `${runId}.json`), "utf8"),
    ) as RunState;
    if (state.schemaVersion !== 1)
      throw new Error(`Unsupported state schema: ${String(state.schemaVersion)}`);
    return state;
  }

  async save(state: RunState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${state.runId}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
}
