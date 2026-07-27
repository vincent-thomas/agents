import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createObsidianExtension } from "./obsidian-tool.ts";
import systemPrompt from "../SYSTEM.md" with { type: "text" };

export async function runVaultkeeper(props: { vaultName: string }): Promise<void> {
  const { vaultName } = props;

  const cwd = process.cwd();
  const agentDir = getAgentDir();

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => systemPrompt,
        appendSystemPromptOverride: () => [],
        extensionFactories: [createObsidianExtension(cwd, vaultName)],
      },
    });

    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        thinkingLevel: "high",
        noTools: "builtin",
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd),
  });

  const mode = new InteractiveMode(runtime, {
    migratedProviders: [],
    modelFallbackMessage: undefined,
    initialMessage: undefined,
    initialImages: [],
    initialMessages: [],
  });

  await mode.run();
}
