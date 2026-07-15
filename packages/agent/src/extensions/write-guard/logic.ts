/**
 * logic.ts — pure helpers for the write-guard extension.
 *
 * No pi imports — importable from the extension index and tests.
 */

/**
 * Check an existing file's line count and return a block reason if the file
 * exceeds the threshold. Returns null when the write should be allowed.
 */
export function checkFileTooLarge(
  filePath: string,
  content: string,
  lineThreshold: number,
): string | null {
  const lineCount = content.split("\n").length;
  if (lineCount <= lineThreshold) return null;
  return (
    `Cannot overwrite "${filePath}" — it has ${lineCount} lines (threshold: ${lineThreshold}). ` +
    `Use the \`edit\` tool to make surgical changes instead. ` +
    `The \`write\` tool on large existing files risks silently dropping content.`
  );
}
