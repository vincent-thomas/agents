import { execFile } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  truncateHead,
  truncateToVisualLines,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Array as TArray, Object as TObject, Optional, String as TString } from "typebox";
import {
  READ_ONLY_OBSIDIAN_COMMANDS,
  buildObsidianArgs,
  formatObsidianInvocation,
  formatObsidianOutput,
} from "./logic.ts";

const MAX_BUFFER = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

class ObsidianCallText {
  constructor(
    private readonly text: string,
    private readonly trailingBlankLine = false,
  ) {}

  render(width: number): string[] {
    const lines = truncateToVisualLines(
      this.text,
      Math.max(1, this.text.length + 1),
      width,
    ).visualLines;
    return this.trailingBlankLine ? [...lines, ""] : lines;
  }

  invalidate(): void {}
}

function executeObsidian(
  cwd: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "obsidian",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        shell: false,
        signal,
        timeout: TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const output = formatObsidianOutput(String(stdout), String(stderr));
          reject(new Error(`Obsidian CLI failed: ${output}`, { cause: error }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function createObsidianExtension(cwd: string, vaultName: string) {
  return function obsidianExtension(pi: ExtensionAPI) {
    pi.registerTool({
      name: "obsidian",
      label: "Obsidian",
      description:
        "Query the configured Obsidian vault through the official CLI. " +
        "Only read-only commands are accepted. Arguments are passed directly as argv without a shell. " +
        "Use the help command with a command name when you need its current official syntax.",
      promptSnippet: "Search and read the configured Obsidian vault without modifying it",
      promptGuidelines: [
        "Use obsidian to ground analysis in the configured vault and cite the note paths returned by it.",
      ],
      parameters: TObject({
        command: StringEnum(READ_ONLY_OBSIDIAN_COMMANDS, {
          description: "Official read-only Obsidian CLI command to invoke",
        }),
        arguments: Optional(
          TArray(TString(), {
            description:
              "CLI arguments as individual argv values, for example ['query=agency', 'limit=20']. Do not include the command or vault argument.",
          }),
        ),
      }),
      renderCall(args, theme, context) {
        let text = theme.fg("toolTitle", theme.bold("Obsidian"));
        if (context.expanded && args.command) {
          const invocation = formatObsidianInvocation(
            buildObsidianArgs(vaultName, args.command, args.arguments ?? []),
          );
          text += `\n${theme.fg("toolOutput", invocation)}`;
        }
        return new ObsidianCallText(text, context.expanded && Boolean(args.command));
      },
      async execute(_toolCallId, params, signal) {
        const args = buildObsidianArgs(vaultName, params.command, params.arguments ?? []);
        const { stdout, stderr } = await executeObsidian(cwd, args, signal);
        const output = formatObsidianOutput(stdout, stderr);
        const truncated = truncateHead(output);
        const text = truncated.truncated
          ? `${truncated.content}\n\n[Obsidian CLI output truncated.]`
          : truncated.content;

        return {
          content: [{ type: "text" as const, text }],
          details: { command: params.command, arguments: params.arguments ?? [] },
        };
      },
    });
  };
}
