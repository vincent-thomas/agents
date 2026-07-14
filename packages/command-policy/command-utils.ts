/**
 * command-utils.ts — shell command parsing used by the matching engine.
 *
 * Self-contained: no dependency on anything else in the vt-pi workspace,
 * only on @mariozechner/pi-coding-agent. Exercised indirectly through
 * matching.test.ts.
 *
 * The goal is to find the *real* executable a shell segment runs, seeing
 * through environment-variable prefixes (`FOO=bar cmd`), absolute paths
 * (`/bin/cat`), alias-busting backslashes (`\cat`), and to look inside
 * pipelines and command substitutions.
 */

// `FOO=bar`, `PYTHONPATH=.` — a leading environment assignment, not a command.
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

/**
 * Split a shell command line into the individual runnable segments. Splits on
 * sequence/pipe operators, newlines, subshell + command-substitution
 * boundaries, and redirections so the leading word of every runnable piece
 * can be inspected independently.
 *
 * Note: multi-char operators (`&&`, `||`, `$(`) are listed before their
 * single-char prefixes so they win the alternation.
 */
export function splitCommandSegments(text: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escape = false;
	let skipRedirectionTarget = false;
	// Nesting depth of $(...) and <(...) — when > 0, ) should not split.
	let substStack: string[] = [];

	function pushCurrent() {
		segments.push(current);
		current = "";
	}

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (skipRedirectionTarget) {
			if (/\s/.test(ch)) continue;
			// Consume the redirection target: an FD number/filename after `>`/`<`, or
			// (after an FD-duplication `&`, e.g. `>&n`, `<&n`, `<&-`) the FD/filename following it.
			if (ch === "&") i++;
			while (i < text.length && !/[\s;|&()`<>{}]/.test(text[i])) i++;
			i--;
			skipRedirectionTarget = false;
			continue;
		}

		if (escape) {
			current += ch;
			escape = false;
			continue;
		}

		if (ch === "\\") {
			current += ch;
			escape = true;
			continue;
		}

		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}

		if (ch === "'" || ch === '"') {
			current += ch;
			quote = ch;
			continue;
		}

		if (ch === ")" && substStack.length > 0) {
			const subType = substStack.pop()!;
			if (subType === "$") {
				// Command substitution $(...) — extract the content as a segment.
				pushCurrent();
			}
			// For process substitution <(...) and >(...), the content is an argument — don't push.
			continue;
		}

		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			pushCurrent();
			i++;
			continue;
		}

		if (ch === "$" && next === "(") {
			pushCurrent();
			substStack.push("$");
			i++;
			continue;
		}

		if (ch === "<" && next === "(") {
			// Process substitution <(...) — not a redirect, treat as part of segment.
			current += "<(";
			substStack.push("<");
			i++;
			continue;
		}

		if (ch === ">" && next === "(") {
			// Process substitution >(...) — not a redirect, treat as part of segment.
			current += ">(";
			substStack.push(">");
			i++;
			continue;
		}

		if (ch === "<" || ch === ">") {
			// Strip trailing FD number before redirection
			// (e.g., `2>` in `cmd 2>file`, `1>>` in `cmd 1>>file`)
			current = current.replace(/(\s+)\d+$/, "$1");
			pushCurrent();
			if (next === "<" || next === ">") i++;
			skipRedirectionTarget = true;
			continue;
		}

		if (/[\n;|&()`{}]/.test(ch)) {
			pushCurrent();
			continue;
		}

		current += ch;
	}

	// If we ended while in a here-doc, the current buffer might be the closing
	// delimiter without a trailing newline. Discard it so it doesn't leak.
	segments.push(current);

	// The loop above treats a double-quoted span as fully opaque, which is
	// right for splitting purposes (quotes suppress word-splitting) but wrong
	// for detection purposes: a shell still expands $(...) and `...` *inside*
	// double quotes, so a banned command can hide there and never appear as
	// its own segment above — e.g. `echo "$(rm -rf /)"` would otherwise only
	// ever surface `echo`. Run a second, additive pass per segment that pulls
	// those hidden substitutions out as extra segments, without touching how
	// the segment above already tokenizes (so it can't turn literal text that
	// merely follows a substitution into a bogus extra "command").
	const withHiddenSubstitutions: string[] = [];
	for (const segment of segments) {
		withHiddenSubstitutions.push(segment);
		withHiddenSubstitutions.push(...quotedSubstitutionContents(segment));
	}
	return withHiddenSubstitutions;
}

/**
 * Scan `segment` for $(...) and `...` command/backtick substitutions that
 * occur *inside* a double-quoted span, and return each one's inner content
 * (recursively split, so nested substitutions/pipelines are found too).
 * Single-quoted spans are skipped entirely — a shell never expands anything
 * inside single quotes. Unquoted spans are skipped too — {@link
 * splitCommandSegments}'s main pass already extracts those.
 */
function quotedSubstitutionContents(segment: string): string[] {
	const found: string[] = [];
	let quote: "'" | '"' | null = null;
	let escape = false;

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];

		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = null;
				continue;
			}
			if (ch === "$" && segment[i + 1] === "(") {
				const close = findMatchingParen(segment, i + 2);
				const inner = segment.slice(i + 2, close);
				found.push(...splitCommandSegments(inner));
				i = close;
				continue;
			}
			if (ch === "`") {
				// Naive: find the next backtick. Doesn't handle a nested backtick
				// pair (legacy syntax that itself can't nest without escaping), but
				// that's an existing, accepted limitation of backtick handling.
				const close = segment.indexOf("`", i + 1);
				if (close === -1) continue;
				const inner = segment.slice(i + 1, close);
				found.push(...splitCommandSegments(inner));
				i = close;
				continue;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
	}

	return found;
}

/**
 * Given the index just after a `$(`, find the index of its matching `)`,
 * tracking nested parens and quotes so a `)` inside a nested substitution or
 * a quoted argument doesn't close it early. Returns `segment.length` if
 * unterminated (unbalanced input — treat the rest of the string as the body).
 */
function findMatchingParen(segment: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | null = null;
	let escape = false;
	for (let i = start; i < segment.length; i++) {
		const ch = segment[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "(") depth++;
		if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return segment.length;
}

/**
 * Sentinel returned by {@link commandInvocation} when a segment's command
 * name or a flag-shaped argument is quoted or backslash-escaped for no
 * syntactic reason — e.g. `"git"`, `\-rf`, or `g""it`. A shell resolves all
 * of these to the exact same literal value as the plain, unescaped form;
 * escaping them has no effect except defeating string-based policy checks.
 *
 * Distinct from `null` ("this segment runs nothing") so callers can't
 * mistake "couldn't resolve, and possibly not safe" for "there's nothing
 * here to worry about" — every caller of commandInvocation must handle
 * OBFUSCATED explicitly (typically: deny the command).
 *
 * We deliberately don't try to resolve the escaping and keep matching
 * through it: a shell offers many ways to spell an equivalent token
 * (quoting, backslash-per-character, concatenation, `$'...'`, variable
 * expansion, …), and chasing each one as it's discovered is a losing
 * game — this project's history is a series of exactly these
 * bypass-then-patch fixes. A legitimate command has no reason to quote or
 * escape a bareword command name or a flag, so any command that does is
 * rejected at the parser step rather than passed on to callers that would
 * otherwise have to reason about what it actually resolves to.
 */
export const OBFUSCATED = "obfuscated" as const;
type ObfuscatedCommand = typeof OBFUSCATED;

// Characters that mean the shell actually needed some form of
// quoting/escaping to deliver this literal value — whitespace and shell
// metacharacters. If none of these survive in the resolved value, whatever
// quoting/escaping produced it was gratuitous.
const NEEDS_ESCAPING = /[\s'"$`\\;&|<>(){}*?[\]!#~]/;

/**
 * Resolve every quote-pair and backslash-escape in `tok` the way a shell
 * would — including adjacent quoted/escaped/plain fragments with no
 * separating whitespace, which the shell just concatenates (`g""it`,
 * `'-r'f`, `\-\-force`, …). Returns null when quoting is unbalanced (a
 * malformed token we can't draw a conclusion from either way).
 *
 * This does not implement full shell semantics — no variable/command
 * substitution, globbing, or `$'...'` ANSI-C strings — it only answers
 * "what literal value would this token be once its quote/backslash-escape
 * mechanisms are peeled off," which is all {@link isPointlessEscaping}
 * needs.
 */
function resolveEscaping(tok: string): string | null {
	let out = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < tok.length; i++) {
		const ch = tok[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				out += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			i++;
			if (i >= tok.length) return null; // trailing, dangling backslash
			out += tok[i];
			continue;
		}
		out += ch;
	}
	return quote ? null : out; // unbalanced quote
}

/**
 * `\cmd` — a single leading backslash before an otherwise plain bareword.
 * A well-known bash idiom for bypassing shell aliases (not obfuscation):
 * the shell strips the backslash and runs the plain word. commandInvocation
 * deliberately resolves through this elsewhere, so it's exempted here too.
 */
function isAliasBustingBackslash(tok: string): boolean {
	return /^\\[A-Za-z0-9_.\-/:+,@]+$/.test(tok);
}

/**
 * True if `tok`, once every quote-pair and backslash-escape a shell
 * recognizes is resolved (see {@link resolveEscaping}), turns out to be a
 * plain bareword — i.e. the escaping was gratuitous, done only to defeat
 * literal-string policy checks rather than because the shell required it.
 *
 * Deliberately not scoped to "wrapped in a matching quote pair": a shell
 * offers many equivalent ways to spell the same literal word — `"git"`,
 * `'git'`, `g\it`, `g""it`, `'-r'f` — and assuming obfuscation only looks
 * like quotes would leave the rest of that space uncovered. This still
 * doesn't chase every shell feature (no `$'...'`, no variable expansion) —
 * it resolves the two mechanisms a model would realistically reach for
 * (quoting and backslash-escaping) and denies anything using them without
 * need, rather than trying to correctly interpret arbitrarily creative
 * shell syntax.
 *
 * Not applied to ordinary argument values (commit messages, search terms,
 * filenames with spaces, …) — those legitimately need quoting/escaping
 * because they actually contain whitespace or metacharacters, so this
 * returns false for them; only a command/flag word with no such content
 * can be "pointlessly" escaped.
 */
function isPointlessEscaping(tok: string): boolean {
	if (isAliasBustingBackslash(tok)) return false;
	return resolvePointlessEscaping(tok) !== null;
}

/**
 * Resolves `tok` through quote/backslash-escaping (see
 * {@link resolveEscaping}) and returns the result only if the escaping was
 * pointless — i.e. the resolved value needs no further escaping. Returns
 * null if `tok` has no quote/backslash chars, the escaping is unbalanced,
 * or the resolved value still needs escaping.
 */
function resolvePointlessEscaping(tok: string): string | null {
	if (!/['"\\]/.test(tok)) return null;
	const resolved = resolveEscaping(tok);
	if (resolved === null || resolved.length === 0) return null;
	if (NEEDS_ESCAPING.test(resolved)) return null;
	return resolved;
}

/**
 * True if `tok` is a flag disguised via quoting/backslash-escaping, e.g.
 * `"-rf"`, `\-rf`, or `'-r'f` — pointless escaping (see
 * {@link isPointlessEscaping}) whose resolved value starts with `-`.
 * Unlike {@link isPointlessEscaping}, the alias-busting `\cmd` exemption
 * does not apply here — there's no legitimate reason to backslash-escape a
 * flag, leading or otherwise.
 */
function isDisguisedFlag(tok: string): boolean {
	return resolvePointlessEscaping(tok)?.startsWith("-") ?? false;
}

/** True if any arg in `args` is a flag disguised via quoting/escaping (see {@link isDisguisedFlag}). */
function hasDisguisedFlag(args: string[]): boolean {
	return args.some(isDisguisedFlag);
}

/**
 * Resolve the actual command a single segment invokes: its executable name
 * (lowercased basename) plus the raw argument tokens that follow. Skips
 * leading environment assignments (`FOO=bar cmd`).
 *
 * Returns:
 *  - `null` when the segment runs nothing (empty, only env assignments, …)
 *  - {@link OBFUSCATED} when the command name or a flag is pointlessly
 *    quoted or backslash-escaped (see {@link isPointlessEscaping}) —
 *    callers must treat this as "deny", not "nothing to see here"
 *  - otherwise the resolved `{ name, args }`
 */
export function commandInvocation(segment: string): { name: string; args: string[] } | null | ObfuscatedCommand {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < tokens.length) {
		let tok = tokens[i];
		if (isPointlessEscaping(tok)) return OBFUSCATED;
		if (tok.startsWith("\\")) tok = tok.slice(1); // `\cat` bypasses aliases
		if (ENV_ASSIGN.test(tok)) {
			i++;
			continue;
		}
		const base = (tok.split("/").pop() ?? tok).toLowerCase();
		// A bare leftover quote/backslash with no real content — can surface from
		// a degenerate substitution body (e.g. `"$(")"`, whose extracted inner
		// text is just `"`). Not a command; skip it like an empty token rather
		// than resolving a nonexistent "command" named `"`.
		if (base === "" || /^['"\\]+$/.test(base)) {
			i++;
			continue;
		}
		const args = tokens.slice(i + 1);
		if (hasDisguisedFlag(args)) return OBFUSCATED;
		return { name: base, args };
	}
	return null;
}

