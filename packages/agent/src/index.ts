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
import { Type } from "@sinclair/typebox";
import { createCommandPolicyExtension } from "@vt-agent/command-policy";
import commandPolicyExtension from "./extensions/command-policy.ts";
import { createwriteGuardExtension } from "./extensions/write-guard";
import { gitCommitExtension } from "./extensions/git-commit";
import { createExploreExtension } from "@vt-agent/explorer";
import { createFixCiExtension } from "@vt-agent/git_push";

import appendSystemPrompt from "../APPEND_SYSTEM.md" with { type: "text" };

const models = builtinModels();

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
        createExploreExtension({
          model: models.getModel("openai-codex", "gpt-5.6-luna"),
          thinkingLevel: "low",
        }),
        createwriteGuardExtension({
          overwriteFileThreshold: 50,
        }),
        gitCommitExtension,
        createFixCiExtension(),
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
