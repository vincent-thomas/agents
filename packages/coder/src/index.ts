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
import commandPolicyExtension, { commandPolicyEntries } from "./extensions/command-policy.ts";
import { createExtensionProfiles } from "./extensions/profiles.ts";
import { createStandupExtension } from "@vt-agent/standup";
import rootCauseExtension from "./extensions/root-cause/index.ts";
import clearExtension from "./extensions/clear/index.ts";
import { createWorkspaceExtension } from "./workspace/extension.ts";
import { createGotoExtension } from "./workspace/goto.ts";
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
let currentWorkspace = selectedWorkspace?.workspace;
const runtimeCwd = currentWorkspace?.worktree ?? startup.primaryCheckout;
const assertWorkspace = async (cwd: string) =>
  currentWorkspace
    ? assertOwnedWorkspace(currentWorkspace, cwd)
    : assertWorkspacePath(runtimeCwd, cwd);
await assertWorkspace(runtimeCwd);
const { safetyExtensions, workspaceExtensions, subagentExtensions } = createExtensionProfiles({
  assertWorkspace,
});

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
    new URL("../agents/review.md", import.meta.url),
    new URL("../agents/right-hand.md", import.meta.url),
  ],
  getModelFn: models.getModel.bind(models),
  inheritedCommandPolicy: commandPolicyEntries,
  promptFns: {
    merge_conflicts: mergeConflictsPrompt,
  },
  workflowFns: {
    merge_conflicts: createMergeConflictsWorkflow({
      assertWorkspace,
    }),
  },
  extensionFactories: subagentExtensions,
});

let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;

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
        ...(currentWorkspace
          ? [
              createWorkspaceExtension({
                store,
                initialWorkspace: currentWorkspace,
                created:
                  selectedWorkspace?.workspace.id !== currentWorkspace.id ||
                  selectedWorkspace.created,
              }),
            ]
          : [
              createGotoExtension({
                store,
                cwd: startup.primaryCheckout,
                async transition(workspace, sessionFile) {
                  const previousWorkspace = currentWorkspace;
                  const migratedSession = SessionManager.forkFrom(sessionFile, workspace.worktree);
                  currentWorkspace = workspace;
                  try {
                    const result = await runtime.switchSession(migratedSession.getSessionFile()!);
                    if (result.cancelled) throw new Error("Workspace transition was cancelled.");
                  } catch (error) {
                    currentWorkspace = previousWorkspace;
                    throw error;
                  }
                },
              }),
            ]),
        commandPolicyExtension,
        createSessionPointerExtension(sessionPointerStore),
        subagentCatalog.createToolsExtension(),
        subagentCatalog.createCommandExtension("review"),
        ...safetyExtensions,
        ...workspaceExtensions,
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

runtime = await createAgentSessionRuntime(createRuntime, {
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
