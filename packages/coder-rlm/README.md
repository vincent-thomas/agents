# coder-rlm

`coder-rlm` is a minimal recursive language model harness built on Pi. The model sees one
tool, `javascript({ code })`; the tool's persistent runtime contains only:

- `context` — external context that is not inserted into the root model prompt
- `llm(prompt, context?)` — a recursive RLM invocation over inherited or delegated context
- `console.log()` and `console.error()` — output returned to the parent model

```ts
import { RLM } from "@vt-agent/coder-rlm";

const rlm = new RLM({ model, context: hugeString, getApiKey, thinkingLevel: "high" });
const result = await rlm.run("Find the major recurring architectural problems.");
```

`thinkingLevel` uses Pi's normal reasoning levels, defaults to `low`, and is inherited by every
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
include aggregate usage. Pi's internal event types are deliberately not exposed as the public
tracing contract.

Top-level `await` is supported and declarations persist between JavaScript calls. Separate
`run()` calls receive separate runtimes. At `maxDepth` (default `3`, minimum `1`), `llm()` becomes an
ordinary Pi model call without the JavaScript tool; only that delegated leaf context is placed
in the leaf prompt.

## Limits

The MVP defaults to 32 model calls per top-level run, a 60-second timeout per JavaScript
execution, and 50,000 characters of tool output. `maxModelCalls`, `executionTimeoutMs`, and
`maxOutputChars` can override those safeguards.

The runtime is a separate Node process with only the host `PATH` retained so Node can be
resolved. Generated code executes in
a `node:vm` context with string/Wasm code generation disabled and no direct `process`,
`require`, filesystem, network, timers, or other host capabilities. A timeout hard-kills the
runtime process.

Cancellation and execution timeouts abort in-flight recursive calls before disposing the worker.
Every run receives a fresh runtime, which is disposed on success, model failure, tool failure, or
abort. These lifecycle guarantees do not expand the sandbox: generated JavaScript still receives
only `context`, `llm()`, and `console`.

This is capability reduction for an MVP, not a production security boundary. `node:vm` is not
designed to safely execute actively hostile code, and the subprocess has no OS-level sandbox.
Do not expose this package to untrusted model output without stronger process/container
isolation.

## Example

The runtime requires `node` on `PATH`. The example loads Pi's normal model runtime and reuses
credentials saved by Pi (normally in `~/.pi/agent/auth.json`). It defaults to
`openai-codex`/`gpt-5.4-mini`; optionally choose `RLM_PROVIDER` and `RLM_MODEL`, then run:

```sh
bun run --filter @vt-agent/coder-rlm example
```

The autonomous evaluation gives the model a large, semantically varied incident corpus and asks
only for its analytical conclusion; it does not tell the model to recurse. Its final metrics show
whether the model chose recursive `llm()` calls, along with depth, call counts, delegated context
sizes, elapsed time, and the expected top themes:

```sh
bun run --filter @vt-agent/coder-rlm evaluate:autonomous
```

For other integrations, pass Pi's `getApiKey(provider)` resolver in `RLMOptions`. The resolver
is invoked for every root and recursive model request, so refreshed credentials are inherited
without putting secrets into prompts or the JavaScript runtime.
