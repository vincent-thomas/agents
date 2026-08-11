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
const result = await rlm.run("Find the major recurring architectural problems.");
```

The root retains its configured model and thinking level. Child tiers default provider-agnostically
to the root model with low/medium/high thinking for fast/balanced/deep. Override child profiles with
`RLMOptions.tierProfiles`, selecting a model, thinking level, and/or request timeout per tier. Choose
the least expensive reliable tier: fast is for mechanical, extractive work and clean summaries;
balanced is the ordinary interpretation/review default; deep is scarce and reserved for ambiguity,
security, architecture, conflicting evidence, consequential advice, or final synthesis. Large context
alone is not a reason for deep. `maxDeepChildren` caps deep-child admission per top-level run (default 4).

`thinkingLevel` uses Pi's normal reasoning levels and defaults to `high` for the root. Pass an
`AbortSignal` to cancel the root model, active recursive calls, and the JavaScript subprocess together:

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

Top-level `await` is supported and declarations persist between JavaScript calls. Separate
`run()` calls receive separate runtimes. At `maxDepth` (default `3`, minimum `1`), spawned children become ordinary Pi model calls without the JavaScript tool; only that delegated leaf context is placed in the leaf prompt. Child handles and terminal results are host-owned and serializable, so children continue after the JavaScript cell returns.

## Limits

The MVP defaults to 32 model calls per top-level run, a 60-second JavaScript stall timeout, a 300-second per-model-request timeout, a 30-minute overall top-level run timeout, a 30-second per-event-observer timeout, 50,000 characters of tool output, and 4 deep children. `maxModelCalls`, `maxDeepChildren`, `javascriptStallTimeoutMs`, `modelRequestTimeoutMs`, `runTimeoutMs`, `eventObserverTimeoutMs`, and `maxOutputChars` can override those safeguards. The JavaScript watchdog only bounds stalled synchronous execution; heartbeats while `ctx.rlm.waitAll()` is waiting prevent model latency from being mistaken for a JavaScript stall. Each model request, event observer, and the overall top-level run have separate host-enforced deadlines. The model-call budget is shared by all recursive
calls in one `run()`; when concurrent delegation exhausts it, active agent turns are stopped and the
primary error remains the budget-limit error rather than a later runtime-lifecycle error.

The runtime is a separate Node process with only the host `PATH` retained so Node can be
resolved. Generated code executes in a `node:vm` context with string/Wasm code generation
disabled and no direct `process`, `require`, network, timers, or other ambient host
capabilities. Its explicit capabilities are limited to `ctx.context`, `ctx.rlm.*`,
`ctx.console.*`, and read-only `ctx.fs.read()`; host protocol results are copied into frozen
sandbox arrays or null-prototype records before generated code receives them. A timeout
hard-kills the runtime process.

Cancellation, model-request timeouts, overall run timeouts, and event-observer timeouts abort in-flight recursive calls before disposing the worker.
Every run receives a fresh runtime, which is disposed on success, model failure, tool failure, or
abort. These lifecycle guarantees do not expand the sandbox: generated JavaScript receives only
`ctx.context`, `ctx.rlm.*`, `ctx.console.*`, and `ctx.fs.read()`.

This is capability reduction for an MVP, not a production security boundary. `node:vm` is not
designed to safely execute actively hostile code, and the subprocess has no OS-level sandbox.
Do not expose this package to untrusted model output without stronger process/container
isolation.

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
library default remains the deliberate 32-call safeguard. It uses the same 60-second JavaScript stall default as the library, while allowing generous model and overall deadlines for high-thinking delegates. Configure recursion and timeouts with positive-integer environment variables `RLM_MAX_DEPTH` (default `3`), `RLM_MAX_MODEL_CALLS` (default `64` for this example), `RLM_JAVASCRIPT_STALL_TIMEOUT_MS` (default `60000`), `RLM_MODEL_REQUEST_TIMEOUT_MS` (default `300000`), `RLM_RUN_TIMEOUT_MS` (default `1800000`), and `RLM_EVENT_OBSERVER_TIMEOUT_MS` (default `30000`); invalid values are rejected using the same validation
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
