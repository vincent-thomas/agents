import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFixCiExtension } from "@vt-agent/git_push";
import { gitCommitExtension } from "./git-commit/index.ts";
import { mergeConflictWriteGuardExtension } from "./merge-conflict-write-guard/index.ts";
import { createwriteGuardExtension } from "./write-guard/index.ts";

export interface CreateExtensionProfilesOptions {
  assertWorkspace(cwd: string): Promise<void>;
}

export function createExtensionProfiles(options: CreateExtensionProfilesOptions) {
  const safetyExtensions: ExtensionFactory[] = [
    mergeConflictWriteGuardExtension,
    createwriteGuardExtension({ overwriteFileThreshold: 50 }),
  ];
  const workspaceExtensions: ExtensionFactory[] = [
    (pi) => gitCommitExtension(pi, { assertWorkspace: options.assertWorkspace }),
    createFixCiExtension({ assertWorkspace: options.assertWorkspace }),
  ];
  const subagentExtensions: ExtensionFactory[] = [...safetyExtensions, ...workspaceExtensions];

  return {
    safetyExtensions,
    workspaceExtensions,
    subagentExtensions,
  };
}
