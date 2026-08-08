# coderv2

`coderv2` is an experimental evidence-gated coding harness. It separates the model's freedom to
choose a strategy from the harness's responsibility to decide what is trusted:

> Hardcode how claims become trusted; do not hardcode how work gets done.

The objective lifecycle is generic (`proposed`, `ready`, `active`, `evaluating`, `satisfied`,
`blocked`, and `invalidated`). There is deliberately no built-in research/fix/test pipeline. A
planner proposes typed actions; deterministic code records their actual effects, evaluates the
contract, and guards every lifecycle transition. A planner's `finish` decision therefore cannot
bypass missing, stale, unsupported, or contradictory evidence.

## Architecture

- **State engine:** versioned, atomically replaced JSON state is canonical. It includes the task
  contract, objective graph, claims, immutable evidence, observations, attempts, blockers, and
  repository fingerprint, so a run can resume without its chat transcript.
- **Controller:** compiles context, asks a provider-neutral `Planner` for one decision, executes
  valid actions, reconciles observations, evaluates predicates, and persists the checkpoint.
- **Context compiler:** deterministically projects bounded, objective-relevant state. It excludes
  unrelated completed objectives and truncates repetitive command output.
- **Executor and evaluator:** the executor captures commands, source reads, diffs, and observed
  file effects. The separate evaluator determines whether that evidence establishes a predicate.

## Evidence and freshness

Evidence has an action ID, objective ID, timestamp, and repository fingerprint. Command and test
evidence is only current at the repository state where it was observed. Source evidence also has a
content hash. User confirmation is the one MVP evidence type that can survive repository changes.
Model judgments remain explicitly typed as `judgment`; they never masquerade as mechanical proof.
Unsupported evidence requirements evaluate to `unknown`.

The repository fingerprint combines `HEAD`, Git status, tracked changes, staged changes, and
untracked file contents. Mutating actions are compared before and after, and changes outside the
contract's allowed paths are recorded as unexpected effects and block the objective.

## CLI

By default, the CLI creates a `ModelPlanner` through Pi's `ModelRuntime`. It reuses Pi's model
catalog and authentication, and reconstructs every model turn from canonical run state. Authenticate
with Pi first, then select any configured model:

```sh
coderv2 run --contract ./task.json --repo . \
  --provider openai-codex --model gpt-5.4 --reasoning medium
coderv2 inspect <run-id>
coderv2 resume <run-id> --provider openai-codex --model gpt-5.4
```

Use `--max-steps` to bound model turns. `ScriptedPlanner` remains available for deterministic
tests and demos by passing `--script ./decisions.json`; planner scripts are JSON arrays of
`PlannerDecision` values.

Example contract:

```json
{
  "intent": "Create and verify a release note",
  "successCriteria": [
    {
      "id": "note-created",
      "description": "The note changed",
      "requirement": { "type": "path_changed", "path": "notes/release.md" }
    },
    {
      "id": "check-passed",
      "description": "The note check passes",
      "requirement": {
        "type": "test_passed",
        "command": "test -s notes/release.md"
      }
    }
  ],
  "invariants": [],
  "allowedEffects": [{ "path": "notes" }]
}
```

Run the focused checks with:

```sh
node --test packages/coderv2/test/*.test.ts
bun x tsc -p packages/coderv2/tsconfig.json --noEmit
```

The repository's canonical full check remains `make`.

## Current limitations

This is an architectural MVP, not a complete autonomous coding agent. It has no semantic retrieval,
multi-agent orchestration, remote sandbox, rollback tree, benchmark runner, PR automation, or UI.
The model planner currently uses JSON-only prompting plus strict local validation rather than native
constrained decoding. Shell commands execute on the host and repository effect boundaries are
enforced from observed Git state after execution; stronger pre-execution isolation is future work.
Evidence gating improves falsifiability and completion discipline, but it is not formal proof of
arbitrary semantic correctness.
