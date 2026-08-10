# coder-rlm

`coder-rlm` is a minimal recursive language model harness built on Pi. The model sees one
tool, `javascript({ code })`; the tool's persistent runtime exposes one capability global:

- `ctx.context` — external context that is not inserted into the root model prompt
- `ctx.llm(prompt, context?)` — a recursive RLM invocation over inherited or delegated context
- `ctx.console.log()` and `ctx.console.error()` — output returned to the parent model
- `ctx.fs.read(selector)` — read-only repository file access, rooted at the host working directory; selectors support `./file.ts`, `./file.ts:100`, and `./file.ts:100-106`

```ts
import { RLM } from "@vt-agent/coder-rlm";

const rlm = new RLM({ model, context: hugeString, getApiKey });
const result = await rlm.run("Find the major recurring architectural problems.");
```

Pass `onEvent` to observe each depth-aware RLM lifecycle event and the underlying Pi agent
events while a run is in progress. Tool start/end events expose the JavaScript code and its
captured console output; recursive calls appear as nested `run_start`/`run_end` events.

Top-level `await` is supported and declarations persist between JavaScript calls. Separate
`run()` calls receive separate runtimes. At `maxDepth` (default `3`, minimum `1`), `ctx.llm()` becomes an
ordinary Pi model call without the JavaScript tool; only that delegated leaf context is placed
in the leaf prompt.

## Limits

The MVP defaults to 32 model calls per top-level run, a 60-second timeout per JavaScript
execution, and 50,000 characters of tool output. `maxModelCalls`, `executionTimeoutMs`, and
`maxOutputChars` can override those safeguards. The model-call budget is shared by all recursive
calls in one `run()`; when concurrent delegation exhausts it, active agent turns are stopped and the
primary error remains the budget-limit error rather than a later runtime-lifecycle error.

The runtime is a separate Node process with only the host `PATH` retained so Node can be
resolved. Generated code executes in
a `node:vm` context with string/Wasm code generation disabled and no direct `process`,
`require`, network, timers, or other host capabilities beyond the read-only `ctx.fs.read()` capability. A timeout hard-kills the
runtime process.

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

To run a focused RLM request with a prompt from the command line:

```sh
bun run --filter @vt-agent/coder-rlm example:prompt "Explain how recursive delegation can help analyze large context."
```

The prompt example prints depth-aware progress, recursive calls, and JavaScript tool code/output to
stderr, leaving the final answer on stdout. It uses a demo-oriented default of 64 model calls so
several concurrent delegates can each recurse and still return their parent synthesis; the `RLM`
library default remains the deliberate 32-call safeguard. Configure recursion with positive-integer
environment variables `RLM_MAX_DEPTH` (default `3`) and `RLM_MAX_MODEL_CALLS` (default `64` for this
example); invalid values are rejected using the same validation as `RLMOptions`:

```sh
RLM_MAX_DEPTH=4 RLM_MAX_MODEL_CALLS=48 \
  bun run --filter @vt-agent/coder-rlm example:prompt "Summarize the repository's retry behavior."
```

The autonomous evaluation gives the model a large, semantically varied incident corpus and asks
only for its analytical conclusion; it does not tell the model to recurse. Its final metrics show
whether the model chose recursive `ctx.llm()` calls, along with depth, call counts, delegated context
sizes, elapsed time, and the expected top themes:

```sh
bun run --filter @vt-agent/coder-rlm evaluate:autonomous
```

For other integrations, pass Pi's `getApiKey(provider)` resolver in `RLMOptions`. The resolver
is invoked for every root and recursive model request, so refreshed credentials are inherited
without putting secrets into prompts or the JavaScript runtime.
