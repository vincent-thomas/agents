export interface EvaluationCorpus {
  context: string;
  reportCount: number;
  multiCauseReportCount: number;
  expectedTopThemes: string[];
}

interface Theme {
  count: number;
  name: string;
  actors: string[];
  failures: string[];
  mechanisms: string[];
  mitigations: string[];
}

const themes: Theme[] = [
  {
    count: 72,
    name: "duplicated identity and authorization decisions",
    actors: ["edge gateway", "claims worker", "support console", "billing boundary", "partner API"],
    failures: [
      "accepted a session rejected by the next service",
      "calculated a broader role than the administrative path",
      "continued honoring access removed earlier that morning",
      "treated emergency privileges differently from the worker",
      "disagreed with the account service about tenant membership",
      "allowed an action the audit path classified as forbidden",
    ],
    mechanisms: [
      "permission rules had been translated into several codebases and evolved independently",
      "the organization had no executable authority for identity decisions shared by every caller",
      "service owners maintained local interpretations of a policy described only in prose",
      "authorization ownership crossed team boundaries without a versioned contract",
      "an old policy snapshot remained embedded in one deployment after newer rules shipped elsewhere",
      "three implementations encoded subtly different fallback behavior for missing claims",
      "access semantics were duplicated between synchronous and asynchronous entry points",
      "the nominal source of truth published data but not the decision logic consumers reproduced",
    ],
    mitigations: [
      "central policy evaluation",
      "a versioned authorization contract",
      "shared conformance cases",
    ],
  },
  {
    count: 64,
    name: "independent timeout and retry configuration",
    actors: ["edge proxy", "checkout client", "job runner", "reporting API", "inventory adapter"],
    failures: [
      "stopped waiting while the upstream operation was still progressing",
      "retried after its caller had already abandoned the request",
      "turned a short slowdown into a burst of duplicate work",
      "held a connection beyond the user-visible deadline",
      "opened another attempt before the first one could finish",
      "exhausted the remaining request budget before reaching storage",
    ],
    mechanisms: [
      "each network hop selected a deadline without inheriting the caller's remaining budget",
      "retry counts were tuned per service and multiplied when components were composed",
      "production defaults diverged among deployment charts maintained by different teams",
      "the queue and HTTP layers used unrelated notions of expiration",
      "backoff behavior ignored the end-to-end latency objective",
      "timeouts lived in environment variables whose provenance nobody could reconstruct",
      "clients retried non-idempotent operations under a generic transient-error policy",
      "no owner was responsible for the aggregate time consumed across boundaries",
    ],
    mitigations: ["propagated deadline budgets", "one retry envelope", "configuration ownership"],
  },
  {
    count: 56,
    name: "business rules embedded in transport handlers",
    actors: [
      "HTTP controller",
      "GraphQL resolver",
      "message consumer",
      "webhook adapter",
      "CLI endpoint",
    ],
    failures: [
      "produced a different decision from the nightly workflow",
      "required the entire web stack for a unit-level policy test",
      "bypassed validation used by the interactive path",
      "mixed persistence changes with response formatting",
      "applied discounts differently from the batch importer",
      "could not reuse the operation from a new protocol adapter",
    ],
    mechanisms: [
      "domain decisions were interleaved with protocol parsing and status-code selection",
      "there was no application-layer operation independent of the web framework",
      "business behavior depended directly on request-scoped framework objects",
      "validation had accumulated in controllers instead of the domain boundary",
      "each transport reconstructed the same workflow with small behavioral differences",
      "transaction boundaries were chosen by handlers rather than the use case",
      "framework middleware had become the only place several invariants were enforced",
      "the model exposed data while adapters retained the rules that gave it meaning",
    ],
    mitigations: [
      "transport-neutral use cases",
      "domain-level invariants",
      "shared workflow tests",
    ],
  },
  {
    count: 48,
    name: "non-idempotent asynchronous processing",
    actors: [
      "invoice consumer",
      "mail job",
      "fulfilment worker",
      "settlement handler",
      "export task",
    ],
    failures: [
      "applied one delivery twice after its visibility lease expired",
      "repeated an external side effect when acknowledgement was lost",
      "created two records during queue redelivery",
      "charged a downstream system again after a worker restart",
      "sent a second notification when ownership moved between workers",
      "replayed a completed operation after recovery",
    ],
    mechanisms: [
      "messages lacked a stable operation identity across delivery attempts",
      "deduplication was assumed to be guaranteed by an at-least-once queue",
      "the side effect and acknowledgement could not commit atomically",
      "idempotency state expired sooner than the broker's redelivery window",
      "workers generated a new request key on every attempt",
      "recovery replayed the log without consulting completed effects",
      "the consumer treated delivery identity as business-operation identity",
      "external calls occurred before durable progress was recorded",
    ],
    mitigations: ["durable operation keys", "an inbox/outbox boundary", "idempotent side effects"],
  },
  {
    count: 40,
    name: "insufficient cross-service observability",
    actors: [
      "search pipeline",
      "notification path",
      "upload flow",
      "subscription workflow",
      "fraud check",
    ],
    failures: [
      "could not be followed beyond the first service boundary",
      "reported success despite a missing downstream span",
      "forced responders to correlate timestamps manually",
      "lost the originating request identifier at an asynchronous hop",
      "produced logs that could not be joined across regions",
      "hid the component responsible for most of the latency",
    ],
    mechanisms: [
      "trace context propagation differed between messaging and HTTP libraries",
      "services emitted incompatible names for the same correlation field",
      "an asynchronous adapter discarded diagnostic metadata",
      "sampling decisions were made independently at every boundary",
      "background work started a new trace without linking its parent",
      "structured logging conventions were optional and diverged by team",
      "the monitoring model covered hosts rather than end-to-end operations",
      "identifiers changed during protocol translation with no recorded mapping",
    ],
    mitigations: [
      "end-to-end trace propagation",
      "shared telemetry semantics",
      "linked async spans",
    ],
  },
  {
    count: 32,
    name: "consumers coupled to unstable data schemas",
    actors: [
      "analytics exporter",
      "mobile backend",
      "audit reader",
      "partner integration",
      "search indexer",
    ],
    failures: [
      "failed after an internal field was renamed",
      "depended on a column absent from the public contract",
      "treated a newly nullable value as always present",
      "broke when producers deployed before consumers",
      "misread a field whose meaning changed without its type changing",
      "stopped processing records written by the newer service",
    ],
    mechanisms: [
      "consumers queried the producer's storage representation directly",
      "schema evolution offered no compatibility window",
      "the integration boundary had never been versioned",
      "generated clients were pinned to an undocumented internal shape",
      "producers removed fields before observing downstream adoption",
      "database tables served simultaneously as persistence and public API",
      "compatibility checks covered syntax but not semantic changes",
      "consumers inferred contracts from example payloads",
    ],
    mitigations: [
      "versioned contracts",
      "consumer-driven compatibility tests",
      "an explicit data boundary",
    ],
  },
];

const teams = ["Atlas", "Beacon", "Cedar", "Drift", "Ember", "Fjord", "Grove", "Harbor"];
const regions = ["eu-north", "us-east", "ap-south", "eu-west", "ca-central"];
const openings = [
  "A routine release first drew attention to",
  "An overnight support escalation exposed",
  "While reconciling an unrelated dashboard, responders noticed",
  "A customer replay captured",
  "Load testing ahead of a seasonal event reproduced",
  "The weekly reliability review connected several alerts to",
];
const investigationVerbs = [
  "The timeline eventually showed that",
  "Comparing behavior across entry points suggested that",
  "A code-history review made clear that",
  "The strongest explanation was that",
  "Reproduction in a staging topology demonstrated that",
  "Interviews with the owning teams established that",
  "The incident commander traced the behavior to the fact that",
  "Evidence from deploy manifests and tests indicated that",
];
const diagnosticQualifiers = [
  "This contradicted the initial single-deploy theory",
  "The pattern only appeared when the complete request path was reconstructed",
  "Several individually reasonable local choices combined into the observed behavior",
  "The defect stayed invisible while components were evaluated in isolation",
  "Recovery data pointed away from capacity and toward the service boundary",
  "Older incidents contained weaker versions of the same interaction",
  "The failure depended on composition rather than one unhealthy process",
  "Rollback changed the symptom without resolving the underlying disagreement",
  "No individual repository contained enough information to explain the outcome",
  "The decisive evidence came from comparing two independently owned paths",
  "Normal component metrics initially concealed the system-level inconsistency",
  "The eventual explanation crossed both deployment and team boundaries",
];
const boundaryEvidence = [
  "contract tests represented only the producer's interpretation",
  "staging omitted the handoff where the behaviors diverged",
  "unit coverage stopped immediately before the consequential interaction",
  "runbooks assigned the adjoining components to different owners",
  "the integration suite asserted availability but not behavioral agreement",
  "release checks validated both sides without comparing their decisions",
  "the fallback path was absent from pre-production traffic",
  "ownership metadata described services but not the operation spanning them",
  "synthetic probes ended before the asynchronous continuation",
  "local dashboards remained green throughout the customer-visible failure",
  "the relevant invariant was not encoded in any cross-service test",
];
const noise = [
  "A dashboard migration happened in the same week but did not affect the failure.",
  "The database remained below forty percent utilization throughout the window.",
  "Responders initially suspected a certificate rotation, which proved unrelated.",
  "A nearby deployment changed UI copy only and was ruled out early.",
  "No packet loss was measured even though the first alert blamed the network.",
  "The on-call handover occurred mid-investigation and added eleven minutes of coordination.",
  "A feature flag with a similar name was disabled, but it controlled a separate path.",
  "Regional traffic volume was ordinary for that day of the week.",
];
const closing = [
  "The immediate patch reduced exposure, although the architectural work remained open.",
  "A narrow guard shipped that day; owners recorded the systemic correction for later planning.",
  "Operations recovered after a local change, without removing the condition elsewhere.",
  "The team restored service first and scheduled the cross-boundary redesign separately.",
  "A rollback ended the incident, but would not prevent another component from repeating it.",
  "Responders added detection while the longer-term boundary change awaited ownership.",
];

export function buildAutonomousEvaluationCorpus(): EvaluationCorpus {
  const reports: Array<{ text: string; diagnostic: string; layout: number }> = [];
  const mentions = themes.map((theme) => ({ name: theme.name, count: 0 }));
  let reportNumber = 1;
  let multiCauseReportCount = 0;

  for (const [themeIndex, theme] of themes.entries()) {
    for (let occurrence = 0; occurrence < theme.count; occurrence++) {
      const id = `INC-${String(reportNumber++).padStart(4, "0")}`;
      const secondaryIndex =
        occurrence % 6 === 0 ? (themeIndex + 3 + (occurrence % 5)) % themes.length : undefined;
      const secondary = secondaryIndex === undefined ? undefined : themes[secondaryIndex];
      mentions[themeIndex].count++;
      if (secondary && secondaryIndex !== undefined) {
        mentions[secondaryIndex].count++;
        multiCauseReportCount++;
      }
      reports.push(buildReport(id, theme, secondary, themeIndex, occurrence));
    }
  }

  validateCorpus(reports, multiCauseReportCount);
  const interleaved = reports
    .map((report, index) => ({ report, order: (index * 97) % reports.length }))
    .sort((a, b) => a.order - b.order)
    .map(({ report }) => report.text);
  const separators = ["\n\n---\n\n", "\n\n***\n\n", "\n\n• • •\n\n"];
  const context = interleaved
    .map((report, index) => `${report}${separators[index % separators.length]}`)
    .join("");
  const expectedTopThemes = mentions
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(({ name }) => name);

  return { context, reportCount: reports.length, multiCauseReportCount, expectedTopThemes };
}

function buildReport(
  id: string,
  primary: Theme,
  secondary: Theme | undefined,
  themeIndex: number,
  occurrence: number,
): { text: string; diagnostic: string; layout: number } {
  const seed = occurrence * 17 + themeIndex * 31;
  const team = pick(teams, seed);
  const region = pick(regions, seed + 3);
  const actor = pick(primary.actors, seed + 5);
  const failure = pick(primary.failures, seed + 7);
  const mechanism = pick(primary.mechanisms, seed + 11);
  const quarter = `202${3 + (occurrence % 4)} Q${1 + ((occurrence + themeIndex) % 4)}`;
  const affected = 2 + ((occurrence * 7 + themeIndex * 13) % 47);
  const minutes = 18 + ((occurrence * 11 + themeIndex * 19) % 143);
  const layout = seed % 6;
  const opening = `${pick(openings, seed + 13)} a case where the ${actor} ${failure} in ${region}.`;
  const diagnostic = `${pick(investigationVerbs, seed + 17)} ${mechanism}. ${pick(diagnosticQualifiers, seed + occurrence * 5)}; ${pick(boundaryEvidence, seed + occurrence * 7)} in ${region}. For ${id}, ${team} could verify its own component but not the behavior of the complete operation.`;
  const secondaryParagraph = secondary
    ? `${pick(investigationVerbs, seed + 23)} ${pick(secondary.mechanisms, seed + 29)}. That additional condition made recovery slower after the original customer-facing symptom appeared.`
    : "";
  const impact = `Customer impact covered ${affected} operations, and reconstruction took ${minutes} minutes despite otherwise normal service saturation.`;
  const mitigation = `${team} proposed ${pick(primary.mitigations, seed + 37)} after service returned. ${pick(closing, seed + 41)}`;
  const irrelevant = pick(noise, seed + 43);

  const layouts = [
    `Incident ${id}\nOwner: ${team} | Window: ${quarter}\n\n${opening}\n\n${impact}\n\n${diagnostic}\n\n${irrelevant}\n\n${secondaryParagraph}\n\n${mitigation}`,
    `${team} reliability note (${quarter})\nReference ${id}\n\nOBSERVATION\n${opening} ${irrelevant}\n\nANALYSIS\n${diagnostic} ${secondaryParagraph}\n\nFOLLOW-UP\n${mitigation} ${impact}`,
    `# ${id}: field notes from ${team}\n\n${impact}\n\n${opening}\n\nWhat changed our view:\n${diagnostic}\n\n${secondaryParagraph}\n\nUnrelated context: ${irrelevant}\n\n${mitigation}`,
    `[${quarter}] ${id} / ${team}\n\n${opening}\n${diagnostic}\n\n${mitigation}\n\nAppendix: ${impact} ${irrelevant}\n${secondaryParagraph}`,
    `Post-incident memo\nCase: ${id}\nGroup: ${team}\n\n${irrelevant}\n\n${opening} ${impact}\n\nRather than a single bad deploy, investigators concluded:\n${diagnostic}\n${secondaryParagraph}\n\n${mitigation}`,
    `${id} — notes assembled after closure\n\n${mitigation}\n\nEarlier in the event, ${opening.toLowerCase()} ${impact}\n\n${secondaryParagraph}\n\nThe causal account:\n${diagnostic}\n\nFor completeness, ${irrelevant.toLowerCase()}`,
  ];
  return { text: layouts[layout], diagnostic, layout };
}

function validateCorpus(
  reports: Array<{ text: string; diagnostic: string; layout: number }>,
  multiCauseReportCount: number,
): void {
  if (reports.some(({ text }) => text.includes("The review found that"))) {
    throw new Error("Autonomous corpus contains the prohibited standardized review sentence");
  }
  if (reports.some(({ text }) => themes.some(({ name }) => text.includes(name)))) {
    throw new Error("Autonomous corpus leaked a canonical ground-truth theme label");
  }
  if (new Set(reports.map(({ text }) => text)).size !== reports.length) {
    throw new Error("Autonomous corpus contains duplicate reports");
  }
  if (new Set(reports.map(({ diagnostic }) => diagnostic)).size !== reports.length) {
    throw new Error("Autonomous corpus contains duplicate diagnostic explanations");
  }
  const normalizedDiagnostics = reports.map(({ diagnostic }) =>
    diagnostic
      .replace(/INC-\d{4}/g, "INC")
      .replace(new RegExp(`\\b(?:${teams.join("|")})\\b`, "g"), "TEAM")
      .replace(new RegExp(`\\b(?:${regions.join("|")})\\b`, "g"), "REGION"),
  );
  if (new Set(normalizedDiagnostics).size !== reports.length) {
    throw new Error("Autonomous corpus relies on identifiers to make diagnostic prose unique");
  }
  if (new Set(reports.map(({ layout }) => layout)).size < 6) {
    throw new Error("Autonomous corpus did not exercise every report layout");
  }
  if (multiCauseReportCount < 40) {
    throw new Error("Autonomous corpus contains too few multi-cause reports");
  }
}

function pick<T>(values: readonly T[], seed: number): T {
  return values[Math.abs(seed) % values.length];
}
