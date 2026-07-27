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
import { gitCommitExtension } from "./extensions/git-commit";
import { createFixCiExtension } from "@vt-agent/git_push";
import { createStandupExtension } from "@vt-agent/standup";
import rootCauseExtension from "./extensions/root-cause/index.ts";
import { createSubagentCatalog } from "./subagents/index.ts";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

import appendSystemPrompt from "../APPEND_SYSTEM.md" with { type: "text" };

const models = builtinModels();

const subagentCatalog = createSubagentCatalog({
  paths: [
    new URL("../agents/scout.md", import.meta.url),
    new URL("../agents/merge-conflicts.md", import.meta.url),
  ],
  getModelFn: models.getModel.bind(models),
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
        commandPolicyExtension,
        subagentCatalog.createToolsExtension(),
        createwriteGuardExtension({
          overwriteFileThreshold: 50,
        }),
        gitCommitExtension,
        createFixCiExtension(),
        createStandupExtension({
          repositories: (
            await execAsync(
              "fd -t d --max-depth 1 . ~/hdr | xargs -n 1 sh -c 'git -C $0 remote get-url origin'",
            )
          ).stdout.split("\n"),
          model: models.getModel("openai-codex", "gpt-5.4-mini"),
        }),
        rootCauseExtension,
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
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: undefined,
  initialImages: [],
  initialMessages: [],
});

await mode.run();
