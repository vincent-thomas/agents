import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RLM, type RLMEvent } from "../src/index.ts";

const provider = process.env.RLM_PROVIDER ?? "openai-codex";
const modelId = process.env.RLM_MODEL ?? "gpt-5.4-mini";
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Unknown Pi model: ${provider}/${modelId}`);

const themes = [
  {
    count: 72,
    expected: "duplicated identity and authorization decisions",
    subjects: ["API gateway", "worker", "admin service", "billing service"],
    symptoms: [
      "accepted a credential another component rejected",
      "evaluated the same role differently",
      "kept a stale copy of the permission rules",
      "implemented emergency access with incompatible checks",
    ],
    causes: [
      "each team had copied the policy into its own repository",
      "ownership of authorization behavior was split across services",
      "the canonical identity contract existed only in design notes",
    ],
  },
  {
    count: 64,
    expected: "independent timeout and retry configuration",
    subjects: ["edge proxy", "checkout client", "job runner", "reporting API"],
    symptoms: [
      "gave up while an upstream operation was still healthy",
      "retried after the caller had already abandoned the request",
      "amplified a brief slowdown into a retry storm",
      "held connections long after the user-visible deadline",
    ],
    causes: [
      "deadlines were configured separately at every hop",
      "retry policy had no shared end-to-end budget",
      "environment defaults had drifted between deployments",
    ],
  },
  {
    count: 56,
    expected: "business rules embedded in transport handlers",
    subjects: ["HTTP controller", "GraphQL resolver", "message consumer", "webhook handler"],
    symptoms: [
      "produced a different outcome from the batch workflow",
      "could not be tested without booting the transport stack",
      "bypassed a rule used by the interactive path",
      "mixed validation, persistence, and response formatting",
    ],
    causes: [
      "domain decisions lived directly beside protocol parsing",
      "there was no reusable application-layer operation",
      "business behavior was coupled to framework request objects",
    ],
  },
  {
    count: 48,
    expected: "non-idempotent asynchronous processing",
    subjects: ["invoice consumer", "email job", "fulfilment worker", "settlement handler"],
    symptoms: [
      "applied the same delivery twice after a visibility timeout",
      "repeated a side effect when acknowledgement was lost",
      "created duplicate records during queue redelivery",
      "charged the downstream system twice after a worker restart",
    ],
    causes: [
      "messages carried no stable operation key",
      "deduplication was assumed to be the queue's responsibility",
      "side effects and acknowledgement were not made atomic",
    ],
  },
  {
    count: 40,
    expected: "insufficient cross-service observability",
    subjects: ["search pipeline", "notification path", "upload flow", "subscription workflow"],
    symptoms: [
      "could not be followed beyond the first service boundary",
      "reported success while the downstream span was missing",
      "required engineers to correlate timestamps by hand",
      "lost the originating request identifier in an asynchronous hop",
    ],
    causes: [
      "trace context was not propagated consistently",
      "services emitted incompatible correlation fields",
      "the asynchronous boundary discarded diagnostic metadata",
    ],
  },
  {
    count: 32,
    expected: "consumers coupled to unstable data schemas",
    subjects: ["analytics exporter", "mobile backend", "audit reader", "partner integration"],
    symptoms: [
      "failed after an internal field was renamed",
      "depended on a column that was never part of a public contract",
      "interpreted a newly nullable field as always present",
      "broke when producers deployed before consumers",
    ],
    causes: [
      "consumers read the producer's storage representation directly",
      "schema evolution had no compatibility window",
      "the integration lacked a versioned boundary",
    ],
  },
] as const;

const teams = ["Atlas", "Beacon", "Cedar", "Drift", "Ember", "Fjord", "Grove", "Harbor"];
const reports: string[] = [];
let reportNumber = 1;
for (const [themeIndex, theme] of themes.entries()) {
  for (let occurrence = 0; occurrence < theme.count; occurrence++) {
    const id = `INC-${String(reportNumber++).padStart(4, "0")}`;
    const subject = theme.subjects[(occurrence * 3 + themeIndex) % theme.subjects.length];
    const symptom = theme.symptoms[(occurrence + themeIndex * 2) % theme.symptoms.length];
    const cause = theme.causes[(occurrence * 2 + themeIndex) % theme.causes.length];
    const team = teams[(occurrence + themeIndex * 3) % teams.length];
    const quarter = `202${3 + (occurrence % 4)} Q${1 + ((occurrence + themeIndex) % 4)}`;
    reports.push(`Report ${id} — ${team} — ${quarter}

During a routine release, the ${subject} ${symptom}. The initial alert described this as an
isolated operational failure, and service health recovered before the investigation began.

The review found that ${cause}. This behavior had accumulated gradually as teams optimized
their own delivery schedules. No single change introduced the failure, and existing unit tests
covered each component independently without exercising the system boundary.

Impact was limited to ${2 + ((occurrence * 7) % 47)} customer operations, but responders spent
${18 + ((occurrence * 11) % 143)} minutes reconstructing the sequence. Follow-up work added a
local safeguard; the broader architectural condition remained open at the time of this report.`);
  }
}

// Interleave themes so useful partitions cannot be obtained from one contiguous range.
const context = reports
  .map((report, index) => ({ report, order: (index * 97) % reports.length }))
  .sort((a, b) => a.order - b.order)
  .map(({ report }) => report)
  .join("\n\n---\n\n");

const metrics = {
  modelCalls: 0,
  javascriptCalls: 0,
  recursiveCalls: 0,
  maxDepth: 0,
  delegatedContextSizes: [] as number[],
};
const startedAt = performance.now();
const rlm = new RLM({
  model,
  context,
  maxDepth: 3,
  maxModelCalls: 32,
  getApiKey: async (providerId) => (await modelRuntime.getAuth(providerId))?.auth.apiKey,
  onEvent: traceAndMeasure,
});

const answer = await rlm.run(
  "Across these engineering incident reports, identify the three most prevalent underlying architectural failure modes. Explain why each one recurs and cite at least two report IDs as evidence.",
);
const elapsedSeconds = (performance.now() - startedAt) / 1_000;

console.log(answer);
console.error("\nAutonomous RLM evaluation");
console.error(`  recursion chosen: ${metrics.recursiveCalls > 0 ? "yes" : "no"}`);
console.error(`  recursive calls: ${metrics.recursiveCalls}`);
console.error(`  maximum depth: ${metrics.maxDepth}`);
console.error(`  model calls: ${metrics.modelCalls}`);
console.error(`  JavaScript calls: ${metrics.javascriptCalls}`);
console.error(
  `  delegated context sizes: ${metrics.delegatedContextSizes.length > 0 ? metrics.delegatedContextSizes.join(", ") : "none"}`,
);
console.error(`  elapsed: ${elapsedSeconds.toFixed(1)}s`);
console.error(`  external context: ${context.length} chars across ${reports.length} reports`);
console.error(
  `  expected top themes: ${themes
    .slice(0, 3)
    .map((theme) => theme.expected)
    .join("; ")}`,
);

function traceAndMeasure(event: RLMEvent): void {
  metrics.maxDepth = Math.max(metrics.maxDepth, event.depth);
  const prefix = `[rlm depth=${event.depth}]`;
  if (event.type === "run_start") {
    if (event.depth > 0) {
      metrics.recursiveCalls++;
      metrics.delegatedContextSizes.push(event.contextLength);
    }
    console.error(
      `${prefix} ${event.depth === 0 ? "start" : "recursive call"}: ${event.prompt} (external context: ${event.contextLength} chars)`,
    );
    return;
  }
  if (event.type === "run_end") {
    console.error(`${prefix} complete`);
    return;
  }
  if (event.type === "run_error") {
    console.error(`${prefix} error: ${event.error}`);
    return;
  }
  if (event.event.type === "turn_start") metrics.modelCalls++;
  if (event.event.type === "tool_execution_start") {
    metrics.javascriptCalls++;
    const code = event.event.args?.code;
    console.error(`${prefix} javascript:\n${typeof code === "string" ? code : "<missing code>"}`);
  } else if (event.event.type === "tool_execution_end") {
    console.error(
      `${prefix} javascript ${event.event.isError ? "error" : "result"}:\n${truncate(toolOutput(event.event.result), 4_000)}`,
    );
  }
}

function toolOutput(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result))
    return String(result);
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return (
    content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n") || "<no output>"
  );
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n... ${value.length - maximum} chars omitted`;
}
