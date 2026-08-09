# coder-rlm

`coder-rlm` is a minimal recursive language model harness built on Pi. The model sees one
tool, `javascript({ code })`; the tool's persistent runtime contains only:

- `context` — external context that is not inserted into the root model prompt
- `llm(prompt, context?)` — a recursive RLM invocation over inherited or delegated context
- `console.log()` and `console.error()` — output returned to the parent model

```ts
import { RLM } from "@vt-agent/coder-rlm";

const rlm = new RLM({ model, context: hugeString, getApiKey });
const result = await rlm.run("Find the major recurring architectural problems.");
```

Pass `onEvent` to observe each depth-aware RLM lifecycle event and the underlying Pi agent
events while a run is in progress. Tool start/end events expose the JavaScript code and its
captured console output; recursive calls appear as nested `run_start`/`run_end` events.

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

For other integrations, pass Pi's `getApiKey(provider)` resolver in `RLMOptions`. The resolver
is invoked for every root and recursive model request, so refreshed credentials are inherited
without putting secrets into prompts or the JavaScript runtime.
