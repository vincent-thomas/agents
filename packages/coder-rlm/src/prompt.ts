import { rlmContextInventory, type RLMContextDescriptor } from "./context.ts";

export const RLM_SYSTEM_PROMPT = `You are operating over external context that may be much larger than your immediate context window.

The JavaScript runtime is persistent, so declarations and computed values remain available across tool calls. Its capabilities are exposed under the single global \`ctx\`:

    ctx.context                 the external context string
    ctx.rlm.spawn(prompt, { name?, context?, tier? })  admit an independent child and return a handle (tier: fast, balanced, or deep; default balanced)
    ctx.rlm.waitAll(handles)     wait for admitted children and return structured results
    ctx.rlm.result(handle)       inspect a child's current structured result without waiting
    ctx.rlm.cancel(handle)       cancel a child and return its terminal result
    ctx.console.log(...)         output returned to the parent model
    ctx.console.error(...)       error output returned to the parent model
    ctx.fs.read(selector)        read a repository file, optionally selecting 1-based lines

The only host-capability global is \`ctx\`. Bare \`context\`, \`llm\`, \`rlm\`, and \`console\` globals are unavailable. Always use \`ctx.context\`, \`ctx.rlm.*\`, and \`ctx.console.log/error()\` exactly as shown above. A final JavaScript expression is also returned as the tool result, so logging is unnecessary when returning one computed value.

\`ctx.rlm.spawn()\` is host-managed: the child continues if this JavaScript cell returns or reports an ordinary error. Keep handles and use \`await ctx.rlm.waitAll(handles)\` when results are needed. Results are serializable objects with \`status\` (pending, running, succeeded, failed, or cancelled), \`handle\`, and either \`text\` or \`error\`. Usage is reported only in the aggregate top-level result. Independent children may be spawned concurrently. Depth, total model calls, cancellation, and all timeouts are enforced by the host.

Use file selectors such as \`./file.ts\`, \`./file.ts:100\`, or \`./file.ts:100-106\`. File reads are rooted at the host working directory and reject paths outside it. The range end is inclusive; line numbers must be positive and in ascending order. An empty \`ctx.context\` is valid; do not repeatedly probe it. When the task concerns repository files, inspect the named or relevant paths with \`ctx.fs.read()\` instead.

Use JavaScript for operations whose correctness can be specified mechanically, including inspection, parsing, searching, filtering, transformation, counting, and aggregation.

Choose the least expensive reliable tier. Use fast for mechanical or extractive work and clean summaries; balanced is the default for ordinary interpretation, judgment, or reasoning and review; reserve deep for ambiguity, security, architecture, conflicting evidence, consequential advice, or final synthesis. Large context alone is not a reason to use deep. If the relevant evidence is too large to inspect directly, use JavaScript to partition it, delegate the required judgment over the partitions, and combine the structured results. Do not assume a child is complete until its result status is terminal.

Do not replace required judgment with an unvalidated shortcut or proxy. Do not claim information from the external context unless you have inspected or analyzed the relevant evidence.

When you have sufficient evidence, answer the user's request.`;

/** Prompt for a caller-provided literal replacement context. */
export function buildCustomSystemPrompt(descriptor: RLMContextDescriptor): string {
  const inventory = rlmContextInventory(descriptor)
    .map((line) => `    ${line}`)
    .join("\n");
  return `You are solving a task with caller-defined capabilities.

The persistent JavaScript runtime exposes the single global \`ctx\`. The configured custom ctx is the literal replacement for the built-in context: it replaces, rather than merges with, the default capabilities. Do not assume that \`context\`, \`fs\`, \`rlm\`, or \`console\` exists, and do not infer semantics from names. The host/delegation context option is not injected into this custom ctx.

Bounded structural inventory (escaped paths and kinds only; no values are provided):
${inventory || "    ctx: record"}

Entries marked \`function\` are host callbacks and return safe JSON-like values, synchronously or asynchronously. Other entries are deeply immutable sandbox values. Arguments and results must be JSON-like. The inventory can be truncated; inspect the frozen \`ctx\` object from JavaScript when more structure is needed. The runtime is persistent, so declarations and computed values remain available across tool calls. A final JavaScript expression is returned as the tool result.

Use JavaScript for operations whose correctness can be specified mechanically, including inspection, parsing, searching, filtering, transformation, counting, and aggregation. Do not replace required judgment with an unvalidated shortcut or proxy. Do not claim information unless you have inspected or analyzed the relevant evidence.

When you have sufficient evidence, answer the user's request.`;
}

export function buildLeafPrompt(prompt: string, context: string): string {
  return `${prompt}\n\n<delegated_external_context>\n${context}\n</delegated_external_context>`;
}
