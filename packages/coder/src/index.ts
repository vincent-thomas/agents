#!/usr/bin/env bun

import {
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createCommandPolicyExtension } from "@vt-agent/command-policy";
import commandPolicyExtension from "./extensions/command-policy.ts";
import { createwriteGuardExtension } from "./extensions/write-guard";
import { mergeConflictWriteGuardExtension } from "./extensions/merge-conflict-write-guard/index.ts";
import { gitCommitExtension } from "./extensions/git-commit";
import { createFixCiExtension } from "@vt-agent/git_push";
import { createStandupExtension } from "@vt-agent/standup";
import rootCauseExtension from "./extensions/root-cause/index.ts";
import clearExtension from "./extensions/clear/index.ts";
import { createWorkspaceExtension } from "./workspace/extension.ts";
import {
  createSessionPointerExtension,
  createSessionPointerStore,
  sessionFileExists,
} from "./session-pointer.ts";
import { LaunchError, parseLaunchCommand } from "./workspace/launch.ts";
import { assertOwnedWorkspace, assertWorkspacePath } from "./workspace/logic.ts";
import { prepareWorkspaceStartup } from "./workspace/startup.ts";
import { createSubagentCatalog } from "./subagents/index.ts";
import { mergeConflictsPrompt } from "./subagents/prompts/merge-conflicts.ts";
import { createMergeConflictsWorkflow } from "./subagents/workflows/merge-conflicts.ts";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

import appendSystemPrompt from "../APPEND_SYSTEM.md" with { type: "text" };

const agentDir = getAgentDir();
const store = { stateDir: agentDir };
const sourceCwd = process.cwd();
const sessionPointerStore = createSessionPointerStore(agentDir);
const startup = await (async () => {
  try {
    const launchCommand = parseLaunchCommand(process.argv.slice(2));
    return await prepareWorkspaceStartup({
      store,
      sourceCwd,
      launchCommand,
      sessionPointers: sessionPointerStore,
    });
  } catch (error) {
    if (!(error instanceof LaunchError)) throw error;
    console.error(`coder: ${error.message}`);
    process.exit(1);
  }
})();
for (const removed of startup.reconciliation.removed) {
  const pullRequest = removed.prNumber === undefined ? "" : ` (PR #${removed.prNumber})`;
  console.log(`Removed merged workspace ${removed.branch}${pullRequest}.`);
}
for (const retained of startup.reconciliation.retained) {
  if (retained.actionable) {
    console.error(`Could not clean up workspace ${retained.branch}: ${retained.reason}.`);
  }
}
if (startup.deletedWorkspace) {
  console.log(`Deleted workspace ${startup.deletedWorkspace.branch}.`);
  process.exit(0);
}
const selectedWorkspace = startup.selectedWorkspace;
const runtimeCwd = selectedWorkspace?.workspace.worktree ?? startup.primaryCheckout;
const assertWorkspace = async (cwd: string) =>
  selectedWorkspace
    ? assertOwnedWorkspace(selectedWorkspace.workspace, cwd)
    : assertWorkspacePath(runtimeCwd, cwd);
await assertWorkspace(runtimeCwd);

const currentSessionFile = await sessionPointerStore.read(runtimeCwd);
const sessionManager =
  currentSessionFile && (await sessionFileExists(currentSessionFile))
    ? SessionManager.open(currentSessionFile)
    : SessionManager.create(runtimeCwd);

const models = builtinModels();

const subagentCatalog = createSubagentCatalog({
  paths: [
    new URL("../agents/scout.md", import.meta.url),
    new URL("../agents/merge-conflicts.md", import.meta.url),
  ],
  getModelFn: models.getModel.bind(models),
  promptFns: {
    merge_conflicts: mergeConflictsPrompt,
  },
  workflowFns: {
    merge_conflicts: createMergeConflictsWorkflow({
      assertWorkspace,
    }),
  },
});

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({
    cwd,
    resourceLoaderOptions: {
      additionalExtensionPaths: [],
      appendSystemPromptOverride(base) {
        return [appendSystemPrompt];
      },
      extensionFactories: [
        ...(selectedWorkspace
          ? [
              createWorkspaceExtension({
                store,
                initialWorkspace: selectedWorkspace.workspace,
                created: selectedWorkspace.created,
              }),
            ]
          : []),
        commandPolicyExtension,
        createSessionPointerExtension(sessionPointerStore),
        subagentCatalog.createToolsExtension(),
        mergeConflictWriteGuardExtension,
        createwriteGuardExtension({
          overwriteFileThreshold: 50,
        }),
        (pi) =>
          gitCommitExtension(pi, {
            assertWorkspace,
          }),
        createFixCiExtension({
          assertWorkspace,
        }),
        createStandupExtension({
          repositories: (
            await execAsync(
              "fd -t d --max-depth 1 . ~/hdr | xargs -n 1 sh -c 'git -C $0 remote get-url origin'",
            )
          ).stdout.split("\n"),
          model: models.getModel("openai-codex", "gpt-5.4-mini"),
        }),
        rootCauseExtension,
        clearExtension,
      ],
    },
  });

  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: runtimeCwd,
  agentDir,
  sessionManager,
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: undefined,
  initialImages: [],
  initialMessages: [],
});

await mode.run();
