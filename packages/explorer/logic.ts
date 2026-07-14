/**
 * logic.ts — pure helpers for the explore sub-agent. No Pi imports: the SDK
 * wiring (createAgentSession, tool registration) lives in index.ts.
 */

/** Safety net for a runaway exploration loop — the SDK exposes no maxTurns option. */
export const MAX_EXPLORE_TURNS = 15;

export function hasExceededTurnLimit(turnCount: number): boolean {
	return turnCount >= MAX_EXPLORE_TURNS;
}

export function buildExplorePrompt(query: string): string {
	return [
		"You are a read-only code exploration assistant. You can only read files,",
		"search (grep/find), and list directories — you cannot write, edit, or run",
		"shell commands.",
		"",
		"Answer the query below as concisely as possible:",
		"- Give a direct, factual answer with file:line references where relevant.",
		"- No preamble, no restating the question, no narration of your steps.",
		"- If you can't find something, say so briefly instead of guessing.",
		"",
		`Query: ${query}`,
	].join("\n");
}

export function formatExploreResult(text: string | undefined): string {
	if (!text || text.trim().length === 0) {
		return "The exploration sub-agent did not return an answer.";
	}
	return text;
}
