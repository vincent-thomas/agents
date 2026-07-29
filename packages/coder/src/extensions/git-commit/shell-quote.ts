/**
 * shell-quote.ts — POSIX single-quote escaping for values interpolated into
 * shell command strings run via execAsync/exec.
 *
 * Self-contained copy, private to @vt-pi/fix-ci: a package keeps its own copy
 * of helpers resembling packages/agent-lord/lib/ rather than importing across
 * that boundary.
 */

/**
 * Wrap `value` in single quotes, safe to splice into a shell command string
 * executed by `/bin/sh -c` (the exec-async / node:child_process exec path).
 *
 * Single quotes suppress all shell interpretation of their contents, so the
 * only case to handle is a literal `'` inside the value: it closes the
 * quote, contributes an escaped literal quote (`\'`), then reopens quoting.
 *
 * Needed anywhere a value isn't a fixed literal — e.g. a git branch name or
 * GitHub login pulled from `gh`/`git` output. git's ref-name rules don't
 * forbid shell metacharacters (`;`, `` ` ``, `$()`, even `'`), so an
 * unescaped branch name spliced into a shell command is a real injection
 * vector, not just a theoretical one.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
