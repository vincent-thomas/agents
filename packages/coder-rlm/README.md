# coder-rlm

`coder-rlm` is a minimal recursive language model harness built on Pi. The model sees one
tool, `javascript({ code })`; the tool's persistent runtime exposes one capability global:

- `ctx.context` — external context that is not inserted into the root model prompt
- `ctx.rlm.spawn(prompt, { name?, context? })` — admit an independent child and receive a serializable handle
- `ctx.rlm.waitAll(handles)` — wait for child results without treating model waiting as JavaScript stall
- `ctx.rlm.result(handle)` and `ctx.rlm.cancel(handle)` — inspect or cancel a child
- `ctx.console.log()` and `ctx.console.error()` — output returned to the parent model
- `ctx.fs.read(selector)` — read-only repository file access, rooted at the host working directory; selectors support `./file.ts`, `./file.ts:100`, and `./file.ts:100-106`

```ts
import { RLM } from "@vt-agent/coder-rlm";

const rlm = new RLM({ model, context: hugeString, getApiKey, thinkingLevel: "high" });
const result = await rlm.run("Find the major recurring architectural problems.");
```

`thinkingLevel` uses Pi's normal reasoning levels, defaults to `high`, and is inherited by every
recursive call. Pass an `AbortSignal` to cancel the root model, active recursive calls, and the
JavaScript subprocess together:

```ts
await rlm.run(prompt, { signal: controller.signal });
```

For aggregate usage across the root and all recursive calls, use `runDetailed()`:

```ts
const { text, usage } = await rlm.runDetailed(prompt);
console.log(usage.modelCalls, usage.totalTokens, usage.cost.total);
```

Pass `onEvent` to observe the stable, depth-aware RLM lifecycle while a run is in progress.
Events include unique `runId`/`parentRunId` relationships and normalized `run_start`,
`model_start`, `model_end`, `javascript_start`, `javascript_end`, `run_end`, and `run_error`
records. JavaScript events expose generated code and captured console output; terminal events
include aggregate usage. Events are queued per top-level run in admission order; asynchronous
observer callbacks are serialized, and the queue is flushed before `runDetailed()` settles. If `onEvent` throws or rejects, the run is aborted and rejects with that
observer error after cleanup; observer failures are never silently swallowed. Pi's internal event
types are deliberately not exposed as the public tracing contract.

Top-level `await` is supported and declarations persist between JavaScript calls. Separate
`run()` calls receive separate runtimes. At `maxDepth` (default `3`, minimum `1`), spawned children become ordinary Pi model calls without the JavaScript tool; only that delegated leaf context is placed in the leaf prompt. Child handles and terminal results are host-owned and serializable, so children continue after the JavaScript cell returns.

## Limits

The MVP defaults to 32 model calls per top-level run, a 60-second JavaScript stall timeout, a 300-second per-model-request timeout, a 30-minute overall top-level run timeout, and 50,000 characters of tool output. `maxModelCalls`, `javascriptStallTimeoutMs`, `modelRequestTimeoutMs`, `runTimeoutMs`, and `maxOutputChars` can override those safeguards. The JavaScript watchdog only bounds stalled synchronous execution; heartbeats while `ctx.rlm.waitAll()` is waiting prevent model latency from being mistaken for a JavaScript stall. Each model request and the overall top-level run have separate host-enforced deadlines. The model-call budget is shared by all recursive
calls in one `run()`; when concurrent delegation exhausts it, active agent turns are stopped and the
primary error remains the budget-limit error rather than a later runtime-lifecycle error.

The runtime is a separate Node process with only the host `PATH` retained so Node can be
resolved. Generated code executes in
a `node:vm` context with string/Wasm code generation disabled and no direct `process`,
`require`, network, timers, or other host capabilities beyond the read-only `ctx.fs.read()` capability. A timeout hard-kills the
runtime process.

Cancellation, model-request timeouts, and overall run timeouts abort in-flight recursive calls before disposing the worker.
Every run receives a fresh runtime, which is disposed on success, model failure, tool failure, or
abort. These lifecycle guarantees do not expand the sandbox: generated JavaScript receives only
`ctx.context`, `ctx.rlm.*`, `ctx.console.*`, and `ctx.fs.read()`.

This is capability reduction for an MVP, not a production security boundary. `node:vm` is not
designed to safely execute actively hostile code, and the subprocess has no OS-level sandbox.
Do not expose this package to untrusted model output without stronger process/container
isolation.

## Example

The runtime requires `node` on `PATH`. The example loads Pi's normal model runtime and reuses
credentials saved by Pi (normally in `~/.pi/agent/auth.json`). It defaults to
`openai-codex`/`gpt-5.6-luna`, and RLM calls request high thinking; optionally choose
`RLM_PROVIDER` and `RLM_MODEL`, then run:

```sh
bun run --filter @vt-agent/coder-rlm example
```

To run a focused RLM request with a prompt from the command line:

```sh
bun run --filter @vt-agent/coder-rlm example:prompt "Explain how recursive delegation can help analyze large context."
```

The prompt example prints depth-aware progress, recursive calls, and JavaScript tool code/output to
stderr, leaving the final answer on stdout. It uses a demo-oriented default of 64 model calls so
several concurrent delegates can each recurse and still return their parent synthesis; the `RLM`
library default remains the deliberate 32-call safeguard. It uses the same 60-second JavaScript stall default as the library, while allowing generous model and overall deadlines for high-thinking delegates. Configure recursion and timeouts with positive-integer environment variables `RLM_MAX_DEPTH` (default `3`), `RLM_MAX_MODEL_CALLS` (default `64` for this example), `RLM_JAVASCRIPT_STALL_TIMEOUT_MS` (default `60000`), `RLM_MODEL_REQUEST_TIMEOUT_MS` (default `300000`), and `RLM_RUN_TIMEOUT_MS` (default `1800000`); invalid values are rejected using the same validation
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
