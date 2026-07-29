import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

interface SessionPointer {
  sessionFile: string;
}

export interface SessionPointerStore {
  read(cwd: string): Promise<string | undefined>;
  write(cwd: string, sessionFile: string): Promise<void>;
  remove(cwd: string): Promise<void>;
}

function pointerPath(stateDir: string, cwd: string): string {
  const id = createHash("sha256").update(cwd).digest("hex");
  return join(stateDir, "current-sessions", `${id}.json`);
}

export function createSessionPointerStore(stateDir: string): SessionPointerStore {
  return {
    async read(cwd) {
      try {
        const pointer = JSON.parse(
          await readFile(pointerPath(stateDir, cwd), "utf8"),
        ) as SessionPointer;
        return typeof pointer.sessionFile === "string" ? pointer.sessionFile : undefined;
      } catch {
        return undefined;
      }
    },

    async write(cwd, sessionFile) {
      const path = pointerPath(stateDir, cwd);
      await mkdir(join(stateDir, "current-sessions"), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify({ sessionFile }) + "\n");
      await rename(temporaryPath, path);
    },

    async remove(cwd) {
      await rm(pointerPath(stateDir, cwd), { force: true });
    },
  };
}

export async function sessionFileExists(sessionFile: string): Promise<boolean> {
  try {
    await access(sessionFile);
    return true;
  } catch {
    return false;
  }
}

export function createSessionPointerExtension(store: SessionPointerStore) {
  return (pi: ExtensionAPI) => {
    pi.on("session_start", async (_event, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) await store.write(ctx.cwd, sessionFile);
    });
  };
}
