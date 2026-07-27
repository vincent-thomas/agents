# AGENTS.md

## Purpose

Use this file as a router, not as a substitute for reading the code. Start at the narrowest path in the table below, follow its imports, and read the colocated tests before changing behavior.

## Repository at a glance

This is a Bun/TypeScript workspace for a customized [Pi coding agent](https://github.com/earendil-works/pi). The host application composes several Pi extensions; most behavior is implemented as small packages or host-local extensions.

| Area                           | Start here                                                   | What lives there                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent assembly/runtime         | `packages/agent/src/index.ts`                                | Creates the Pi session/runtime and registers active extensions. This is the source of truth for what the shipped agent actually enables.                                                                                         |
| Host command allowlist         | `packages/agent/src/extensions/command-policy.ts`            | Concrete allowed/banned commands, subcommands, flags, and guidance.                                                                                                                                                              |
| Command-name policy predicates | `packages/agent/src/extensions/command-policy-predicates.ts` | Host-specific matching for Python, Perl, and awk executable names.                                                                                                                                                               |
| Reusable command-policy engine | `packages/command-policy/index.ts`                           | Public exports. Follow into `extension.ts` for Pi wiring, `matching.ts` for policy decisions, `command-utils.ts` for shell tokenization, and `types.ts` for rule shapes.                                                         |
| Safe-write enforcement         | `packages/agent/src/extensions/write-guard/index.ts`         | Pi hook that blocks whole-file overwrites of large existing files; pure threshold logic is in `logic.ts`.                                                                                                                        |
| Commit tool                    | `packages/agent/src/extensions/git-commit/index.ts`          | Registers `git_commit` and orchestrates branch checks, prechecks, staging, and commit. Helpers are split into `logic.ts`, `precheck.ts`, `git-utils.ts`, `exec-async.ts`, and `shell-quote.ts`.                                  |
| Push/CI/PR workflow            | `packages/fix-ci/index.ts`                                   | Implements the `push_and_check_ci` extension. Most git/GitHub polling and PR logic is in `logic.ts`; process/git helpers are adjacent. **This package currently exists but is not registered in `packages/agent/src/index.ts`.** |
| Build/package                  | `Makefile`, `flake.nix`, `package.json`                      | Workspace, Bun build/test entry points, and Nix packaging.                                                                                                                                                                       |
| CI                             | `.github/workflows/ci.yaml`                                  | Installs with Bun and runs `make`.                                                                                                                                                                                               |

## Route by task

- Change which extensions/models the agent uses: `packages/agent/src/index.ts`.
- Add or alter an allowed shell command: edit the host rules in `packages/agent/src/extensions/command-policy.ts`; change parsing or matching semantics only in `packages/command-policy/`.
- Debug a command unexpectedly allowed or blocked: trace `command-utils.ts` -> `matching.ts` -> host `command-policy.ts`. Add a regression test in `matching.test.ts` or `command-policy-predicates.test.ts`.
- Change overwrite thresholds or write interception: `packages/agent/src/extensions/write-guard/index.ts`; keep the decision logic in `logic.ts`.
- Change commit orchestration/UI responses: `packages/agent/src/extensions/git-commit/index.ts`. Put testable branch/commit decisions in `logic.ts`, Makefile validation in `precheck.ts`, and process plumbing in the helper files.
- Change push, CI polling, PR creation/review, or retry behavior: `packages/fix-ci/index.ts` for orchestration and response text; `packages/fix-ci/logic.ts` for git/GitHub operations and polling.
- Change release/runtime packaging: inspect both `flake.nix` and `packages/agent/package.json`; the Nix wrapper runs the TypeScript entry point directly with Bun.

## Control flow and boundaries

1. `packages/agent/src/index.ts` creates Pi services and supplies extension factories.
2. Extensions either register tools (`git_commit`) or intercept Pi events (command policy and write guard).
3. Extension entry points own SDK integration and user-facing progress/results.
4. Pure or mostly pure decisions belong in adjacent `logic.ts` modules so they can be tested without a Pi session.
5. Shell execution must stay asynchronous and carry `AbortSignal` through long-running git/GitHub operations so the TUI remains responsive.

Do not assume a workspace package is active merely because it is listed as a dependency. Verify registration in `packages/agent/src/index.ts`.

## Exploration workflow

1. Read the package's `package.json` and entry point.
2. Follow imports into the smallest relevant helper; avoid reading all of large files such as `packages/fix-ci/logic.ts` when a symbol search will do.
3. Read the colocated `*.test.ts` files to establish edge cases and intended behavior.
4. Search callers before changing exported types or helper signatures.
5. Ignore `node_modules/`, `result` (a Nix-store symlink), generated `dist/`, and lockfiles unless the task specifically concerns dependencies or packaging.

Useful searches:

```sh
fd --type f . packages
rg "registerTool|pi\.on" packages
rg "create[A-Za-z]+Extension" packages
rg "symbolName" packages
```

## Development and validation

Use Bun, not npm/yarn/pnpm. The repository's canonical checks are:

```sh
bun install       # only when dependencies need installation/update
make              # builds packages/agent and runs the full Bun test suite
bun test          # all tests without the build
bun test path/to/file.test.ts
bunx oxfmt --write path/to/changed-file.ts
nix build         # validate Nix packaging when flake/build behavior changes
```

CI runs `bun install` followed by `make`. Before finishing a code change, run the narrowest relevant test first, then `make` when practical.

## Change conventions

- Keep SDK/tool registration in entry-point or extension files and extract independently testable decisions into `logic.ts`.
- Add or update a colocated regression test for behavior changes.
- Preserve ESM imports and explicit `.ts` extensions used throughout the workspace.
- Use `node:test` and `node:assert/strict`, matching existing tests; tests are executed by Bun at the repository level.
- Prefer focused edits. Do not hand-edit `bun.lock` except as the result of a dependency operation.
- Be careful around the two Pi SDK package names currently present: newer code uses `@earendil-works/...`, while `command-policy` and `fix-ci` still import `@mariozechner/pi-coding-agent`. Follow the package being edited; do not perform an SDK migration as incidental cleanup.
- Preserve user-facing safety guarantees: command policy is deny-by-default, exploration remains read-only, large existing files use exact edits rather than whole-file writes, and git operations avoid default-branch commits/history rewriting.
