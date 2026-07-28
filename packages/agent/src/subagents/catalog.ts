import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadSubagentDefinitions, type SubagentDefinition } from "./definitions.ts";
import { createSubagentToolsExtension, type SubagentInvocation } from "./extension.ts";
import { createSubagentSession, type Subagent } from "./session.ts";

export interface SubagentPromptContext {
  cwd: string;
  definition: SubagentDefinition;
  signal?: AbortSignal;
}

export type SubagentPromptFn = (context: SubagentPromptContext) => string | Promise<string>;

export interface SubagentWorkflowContext extends SubagentPromptContext {
  subagent: Subagent;
  prompt: string;
  onProgress(text: string): void;
}

export type SubagentWorkflowFn = (context: SubagentWorkflowContext) => Promise<string | undefined>;

export interface CreateSubagentCatalogOptions {
  paths: readonly (string | URL)[];
  getModelFn(provider: string, model: string): Model<any>;
  promptFns?: Record<string, SubagentPromptFn>;
  workflowFns?: Record<string, SubagentWorkflowFn>;
  extensionFactories?: ExtensionFactory[];
  customTools?: ToolDefinition[];
}

export interface CreateCatalogSubagentOptions {
  cwd: string;
  parentPrompt?: string;
  agentDir?: string;
  extensionFactories?: ExtensionFactory[];
  customTools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface SubagentCatalog {
  definitions: SubagentDefinition[];
  create(name: string, options: CreateCatalogSubagentOptions): Promise<Subagent>;
  invoke(name: string, options: CreateCatalogSubagentOptions): Promise<SubagentInvocation>;
  createToolsExtension(names?: string[]): ExtensionFactory;
}

export function createSubagentCatalog(options: CreateSubagentCatalogOptions): SubagentCatalog {
  const definitions = loadSubagentDefinitions(options.paths);
  for (const definition of definitions) {
    if (definition.prompt !== "parent" && !options.promptFns?.[definition.prompt]) {
      throw new Error(`Unknown prompt source '${definition.prompt}' in ${definition.filePath}`);
    }
  }

  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const models = new Map(
    definitions.map((definition) => {
      const separator = definition.model.indexOf("/");
      if (separator <= 0 || separator === definition.model.length - 1) {
        throw new Error(
          `Invalid sub-agent model '${definition.model}' in ${definition.filePath}: ` +
            "expected '<provider>/<model>'",
        );
      }

      try {
        return [
          definition.name,
          options.getModelFn(
            definition.model.slice(0, separator),
            definition.model.slice(separator + 1),
          ),
        ] as const;
      } catch (error) {
        throw new Error(
          `Could not resolve model '${definition.model}' from ${definition.filePath}`,
          { cause: error },
        );
      }
    }),
  );

  const requireDefinition = (name: string): SubagentDefinition => {
    const definition = byName.get(name);
    if (!definition) throw new Error(`Unknown sub-agent '${name}'`);
    return definition;
  };

  const createFromDefinition = async (
    definition: SubagentDefinition,
    createOptions: CreateCatalogSubagentOptions,
  ): Promise<Subagent> => {
    const nestedDefinitions = definition.subagents.map(requireDefinition);
    const nestedExtension =
      nestedDefinitions.length === 0
        ? []
        : [
            createSubagentToolsExtension({
              definitions: nestedDefinitions,
              invokeSubagent: (child, context) => invokeDefinition(child, context),
            }),
          ];

    return createSubagentSession({
      definition,
      cwd: createOptions.cwd,
      model: models.get(definition.name)!,
      agentDir: createOptions.agentDir,
      extensionFactories: [
        ...nestedExtension,
        ...(options.extensionFactories ?? []),
        ...(createOptions.extensionFactories ?? []),
      ],
      customTools: [...(options.customTools ?? []), ...(createOptions.customTools ?? [])],
      signal: createOptions.signal,
    });
  };

  const invokeDefinition = async (
    definition: SubagentDefinition,
    createOptions: CreateCatalogSubagentOptions,
  ): Promise<SubagentInvocation> => {
    const prompt =
      definition.prompt === "parent"
        ? createOptions.parentPrompt
        : await options.promptFns![definition.prompt]!({
            cwd: createOptions.cwd,
            definition,
            signal: createOptions.signal,
          });
    if (!prompt || prompt.trim() === "") {
      throw new Error(`Prompt source '${definition.prompt}' returned no prompt`);
    }

    const subagent = await createFromDefinition(definition, createOptions);
    const workflow = options.workflowFns?.[definition.prompt];
    return {
      subagent,
      prompt,
      ...(workflow
        ? {
            run: (onProgress: (text: string) => void) =>
              workflow({
                cwd: createOptions.cwd,
                definition,
                signal: createOptions.signal,
                subagent,
                prompt,
                onProgress,
              }),
          }
        : {}),
    };
  };

  return {
    definitions,
    create: (name, createOptions) => createFromDefinition(requireDefinition(name), createOptions),
    invoke: (name, createOptions) => invokeDefinition(requireDefinition(name), createOptions),
    createToolsExtension(names = definitions.map((definition) => definition.name)) {
      const exposedDefinitions = names.map(requireDefinition);
      return createSubagentToolsExtension({
        definitions: exposedDefinitions,
        invokeSubagent: (definition, context) => invokeDefinition(definition, context),
      });
    },
  };
}
