import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  loadSubagentDefinitions,
  type SubagentDefinition,
} from "./definitions.ts";
import { createSubagentToolsExtension } from "./extension.ts";
import {
  createSubagentSession,
  type Subagent,
} from "./session.ts";

export interface CreateSubagentCatalogOptions {
  paths: readonly (string | URL)[];
  getModel(provider: string, model: string): Model<any>;
  extensionFactories?: ExtensionFactory[];
  customTools?: ToolDefinition[];
}

export interface CreateCatalogSubagentOptions {
  cwd: string;
  agentDir?: string;
  extensionFactories?: ExtensionFactory[];
  customTools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface SubagentCatalog {
  definitions: SubagentDefinition[];
  create(name: string, options: CreateCatalogSubagentOptions): Promise<Subagent>;
  createToolsExtension(names?: string[]): ExtensionFactory;
}

export function createSubagentCatalog(
  options: CreateSubagentCatalogOptions,
): SubagentCatalog {
  const definitions = loadSubagentDefinitions(options.paths);
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
          options.getModel(
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
              createSubagent: (child, context) =>
                createFromDefinition(child, context),
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
      customTools: [
        ...(options.customTools ?? []),
        ...(createOptions.customTools ?? []),
      ],
      signal: createOptions.signal,
    });
  };

  return {
    definitions,
    create: (name, createOptions) =>
      createFromDefinition(requireDefinition(name), createOptions),
    createToolsExtension(names = definitions.map((definition) => definition.name)) {
      const exposedDefinitions = names.map(requireDefinition);
      return createSubagentToolsExtension({
        definitions: exposedDefinitions,
        createSubagent: (definition, context) =>
          createFromDefinition(definition, context),
      });
    },
  };
}
