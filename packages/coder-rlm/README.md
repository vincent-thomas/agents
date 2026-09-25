# coder-rlm

`coder-rlm` is a minimal recursive language model harness built on Pi. The model sees one
tool, `javascript({ code })`; the tool's persistent runtime exposes one capability global:

- `ctx.context` — external context that is not inserted into the root model prompt
- `ctx.rlm.spawn(prompt, { name?, context?, tier? })` — admit an independent child and receive a serializable handle (`tier` is `fast`, `balanced`, or `deep`; default `balanced`)
- `ctx.rlm.waitAll(handles)` — wait for child results without treating model waiting as JavaScript stall
- `ctx.rlm.result(handle)` and `ctx.rlm.cancel(handle)` — inspect or cancel a child
- `ctx.console.log()` and `ctx.console.error()` — output returned to the parent model
- `ctx.fs.read(selector)` — read-only repository file access, rooted at the host working directory; selectors support `./file.ts`, `./file.ts:100`, and `./file.ts:100-106`

```ts
import { RLM } from "@vt-agent/coder-rlm";

const rlm = new RLM({ model, context: hugeString, getApiKey, thinkingLevel: "high" });

// A custom ctx is a live read-only facade over an unsafe in-process replacement; defaults are not merged in.
const custom = new RLM({
  model,
  context: hugeString, // host/delegation context; not injected into custom ctx
  ctx: {
    data: { answer: 42 },
    lookup: async (key) => ({ key, found: key === "answer" }),
  },
});
const result = await rlm.run("Find the major recurring architectural problems.");
```

The root retains its configured model and thinking level. Child tiers default provider-agnostically
to the root model with low/medium/high thinking for fast/balanced/deep. Override child profiles with
`RLMOptions.tierProfiles`, selecting a model, thinking level, and/or request timeout per tier. Choose
the least expensive reliable tier: fast is for mechanical, extractive work and clean summaries;
balanced is the ordinary interpretation/review default; deep is scarce and reserved for ambiguity,
security, architecture, conflicting evidence, consequential advice, or final synthesis. Large context
alone is not a reason for deep. `maxDeepChildren` caps deep-child admission per top-level run (default 4). `maxChildren` caps cumulative child admission per top-level run (default `maxModelCalls`); the quota is not replenished when a child completes, is canceled, or fails.

`thinkingLevel` uses Pi's normal reasoning levels and defaults to `high` for the root. Pass an
`AbortSignal` to cancel the root model, active recursive calls, and the JavaScript runtime together:

```ts
await rlm.run(prompt, { signal: controller.signal });
```

For aggregate usage across the root and all recursive calls, use `runDetailed()`:

```ts
const { text, usage } = await rlm.runDetailed(prompt);
console.log(usage.modelCalls, usage.totalTokens, usage.cost.total);
```

Pass `onEvent` to observe the stable RLM lifecycle while a run is in progress. The examples render this lifecycle as a live tree dashboard on interactive stderr (with model-call budget, active agents, depth, and elapsed time); redirected stderr uses compact append-only lines. Child names and stable tree connectors keep interleaved parallel siblings distinct, while numeric run IDs stay hidden in the dashboard.
Events include unique `runId`/`parentRunId` relationships and normalized `run_start`,
`model_start`, `model_end`, `javascript_start`, `javascript_end`, `run_end`, and `run_error`
records. Child lifecycle records and serializable handles expose the selected tier, never the
resolved model. JavaScript events expose generated code and captured console output; terminal events
include aggregate usage. Events are queued per top-level run in admission order; asynchronous
observer callbacks are serialized and each callback is host-bounded by `eventObserverTimeoutMs` (default 30 seconds). The queue is flushed before `runDetailed()` settles when observers are healthy. If `onEvent` throws, rejects, or exceeds its deadline, the queue closes, queued-but-undelivered events are skipped, active work and children are aborted, and `runDetailed()` rejects with that observer error after cleanup. The callback itself cannot be canceled, but its late settlement is detached safely and cannot deliver later events. The overall `runTimeoutMs` deadline remains active through event flushing, so a flush that outlives the run deadline is closed and rejected rather than hanging. Pi's internal event
types are deliberately not exposed as the public tracing contract.

Top-level `await` is supported and declarations persist between JavaScript calls in default worker
mode. Custom-`ctx` cells have local declarations and should store cross-call state in mutable values
reachable from the `ctx` facade, not by assigning root keys. Separate `run()` calls receive separate runtimes;
a supplied custom `ctx` remains the same shared host source, so source changes remain visible through its facade. At `maxDepth` (default `3`, minimum `1`), spawned children become ordinary Pi model calls without the JavaScript tool; only that delegated leaf context is placed in the leaf prompt. Child handles and terminal results are host-owned and serializable, so children continue after the JavaScript cell returns.

## Limits

The MVP defaults to 32 model calls and 32 cumulative child admissions per top-level run, a 60-second JavaScript stall timeout, a 300-second per-model-request timeout, a 30-minute overall top-level run timeout, a 30-second per-event-observer timeout, 50,000 characters of tool output, and 4 deep children. `maxModelCalls`, `maxChildren`, `maxDeepChildren`, `javascriptStallTimeoutMs`, `modelRequestTimeoutMs`, `runTimeoutMs`, `eventObserverTimeoutMs`, and `maxOutputChars` can override those safeguards. In default worker mode, the JavaScript watchdog hard-stops stalled synchronous execution; heartbeats while `ctx.rlm.waitAll()` is waiting prevent model latency from being mistaken for a JavaScript stall. Model-request, observer, and overall deadlines remain host-enforced unless unsafe custom-`ctx` code blocks the host event loop. The model-call budget is shared by all recursive
calls in one `run()`; when concurrent delegation exhausts it, active agent turns are stopped and the
primary error remains the budget-limit error rather than a later runtime-lifecycle error.

When `ctx` is omitted, the runtime is a separate Node process with only the host `PATH` retained so
Node can be resolved. Generated code executes in a `node:vm` context with string/Wasm code generation
disabled and no direct `process`, `require`, network, timers, or ambient capabilities beyond
`ctx.context`, `ctx.rlm.*`, `ctx.console.*`, and read-only `ctx.fs.read()`. Host protocol results are
copied into frozen sandbox arrays or null-prototype records, and a timeout hard-kills the worker.

In default worker mode, cancellation and deadlines abort in-flight recursive calls before disposing the runtime. Yielding custom-`ctx` execution can be rejected on cancellation or timeout, but synchronous custom code prevents host timers and abort handlers from running.

Supplying `RLMOptions.ctx` deliberately selects a different, unsafe mode. Generated cells execute as
host-realm functions whose `ctx` argument is a live read-only facade over the supplied object, replacing
`{ context, fs, rlm, console }`; root writes, deletion, descriptor changes, prototype changes, and
freezing/sealing attempts are rejected. `RLMOptions.context` remains host/delegation context and is not
injected. Nested and function-returned objects are live mutable membrane views: writes forward to their
originals, cycles and references back to the root resolve to the facade, and arrays/classes/accessors retain
host-receiver behavior. Nested preventExtensions/seal/freeze operations are rejected so the live membrane can
preserve virtual descriptors. Calling a top-level function as a `ctx` method uses the original source as `this`;
such functions can have host authority and may mutate the source. Arguments and return values are wrapped across the membrane. The root
facade has no prototype, but this is not a security boundary. The worker boundary, hard-kill guarantee, and
`javascriptStallTimeoutMs` protection against synchronous infinite code do not apply. An asynchronous execution
can be rejected on timeout or abort, but already-running host callbacks cannot be forcibly canceled. A suspended
cell may resume after its caller has been rejected and can still mutate reachable shared source values.

Default worker mode is capability reduction for an MVP, not a production security boundary because
`node:vm` is not designed for actively hostile code and the subprocess has no OS-level sandbox.
Custom `ctx` mode provides no security boundary at all. Do not use it with untrusted model output.

## Example

The runtime requires `node` on `PATH`. The example loads Pi's normal model runtime and reuses
credentials saved by Pi (normally in `~/.pi/agent/auth.json`). It defaults the root to
`openai-codex`/`gpt-5.6-luna` and demonstrates tier-aware recursive calls; optionally choose
`RLM_PROVIDER` and `RLM_MODEL`, then run:

```sh
bun run --filter @vt-agent/coder-rlm example
```

To run a focused RLM request with a prompt from the command line:

```sh
bun run --filter @vt-agent/coder-rlm example:prompt "Explain how recursive delegation can help analyze large context."
```

The prompt example prints a live tree dashboard on interactive stderr (or compact append-only
progress when stderr is redirected), leaving the final answer on stdout. It shows model-call budget,
active agents, depth, elapsed time, and concise JavaScript status; successful JavaScript result bodies
are intentionally suppressed while errors remain prominent. It uses a demo-oriented default of 64 model calls so
several concurrent delegates can each recurse and still return their parent synthesis; the `RLM`
library default remains the deliberate 32-call safeguard. It uses the same 60-second JavaScript stall default as the library, while allowing generous model and overall deadlines for high-thinking delegates. Configure recursion and resource limits with integer environment variables `RLM_MAX_DEPTH` (default `3`), `RLM_MAX_MODEL_CALLS` (default `64` for this example), `RLM_MAX_CHILDREN` (non-negative, default `RLM_MAX_MODEL_CALLS`), `RLM_JAVASCRIPT_STALL_TIMEOUT_MS` (default `60000`), `RLM_MODEL_REQUEST_TIMEOUT_MS` (default `300000`), `RLM_RUN_TIMEOUT_MS` (default `1800000`), and `RLM_EVENT_OBSERVER_TIMEOUT_MS` (default `30000`); invalid values are rejected using the same validation
as `RLMOptions`:

```sh
RLM_MAX_DEPTH=4 RLM_MAX_MODEL_CALLS=48 RLM_JAVASCRIPT_STALL_TIMEOUT_MS=300000 \
  bun run --filter @vt-agent/coder-rlm example:prompt "Summarize the repository's retry behavior."
```

The autonomous evaluation gives the model a large, semantically varied incident corpus and asks
only for its analytical conclusion; it does not tell the model to recurse. Its final metrics show
whether the model chose recursive `ctx.rlm.spawn()` calls, along with depth, call counts, delegated context
sizes, elapsed time, and the expected top themes:

```sh
bun run --filter @vt-agent/coder-rlm evaluate:autonomous
```

For other integrations, pass Pi's `getApiKey(provider)` resolver in `RLMOptions`. The resolver
is invoked for every root and recursive model request, so refreshed credentials are inherited
without putting secrets into prompts or the JavaScript runtime.
