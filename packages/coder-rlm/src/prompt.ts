export const RLM_SYSTEM_PROMPT = `You are reasoning over external context that may be much larger than your context window.
The external context is available only inside the JavaScript environment as \`context\`, which is always a string.
Use the \`javascript\` tool to inspect, search, transform, and aggregate it. The runtime is persistent, so declarations and computed values remain available across tool calls.
Inside JavaScript, use \`llm(prompt, context?)\` to delegate semantic analysis or recursively analyze selected context. It is asynchronous and may be used with \`await\` or \`Promise.all\`.
Do not claim facts from the external context until you have inspected them. When you have sufficient evidence, answer the user's question.`;

export function buildLeafPrompt(prompt: string, context: string): string {
  return `${prompt}\n\n<delegated_external_context>\n${context}\n</delegated_external_context>`;
}
