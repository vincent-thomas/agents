# Agent

A safety-focused coding agent built on the
[Pi coding agent](https://github.com/earendil-works/pi). This repository wraps
Pi with project-specific tools and policies for exploring code, editing files,
and creating verified Git commits.

## What it adds

The runtime in `packages/coder/src/index.ts` currently enables:

- **Command policy** — shell commands are denied by default. Approved commands,
  subcommands, and flags are defined explicitly.
- **Write guard** — existing files longer than 50 lines cannot be replaced
  wholesale with the `write` tool; targeted `edit` operations are required.
- **Commit guard** — the `git_commit` tool runs pre-checks and refuses to commit
  on a default branch.
- **Working conventions** — the appended system prompt asks the agent to make
  focused changes, verify them, and keep a clean Git history.

The `packages/fix-ci` workspace contains a push/CI/PR extension, but it is **not
registered in the current runtime**. Do not assume a workspace dependency is an
active agent feature; `packages/coder/src/index.ts` is the source of truth.

## Requirements

- [Bun](https://bun.sh/) (the workspace and CI use Bun, not npm)
- GNU Make
- Git
- Credentials for a model provider supported by Pi
- Optional: Nix with flakes enabled

## Quick start

Install dependencies from the repository root:

```bash
bun install
```

Start the interactive agent from the repository you want it to operate on:

```bash
bun run /path/to/agents/packages/coder/src/index.ts
```

With no arguments, coder runs in the repository's primary checkout and resumes
its current session, even when invoked from a linked worktree. `/clear` replaces
that session and removes its prior transcript. Use `goto <branch-name>` to create
an isolated managed worktree on that exact new branch, or `goto` to choose among
active managed workspaces.
Creating a workspace fails when the requested local branch already exists.

On first use, enter `/login` in the Pi interface and authenticate with a model
provider. The exploration tool is currently configured to use OpenAI model
`gpt-5.6-luna`, so exploration requires OpenAI credentials even if the parent
session uses another provider.

### Nix

Enter the development shell:

```bash
nix develop
bun install
make
```

Or build and run the packaged application:

```bash
nix build
./result/bin/agent
```

The Nix wrapper runs the TypeScript entry point directly with Bun.

## Development

Run the canonical build and test suite:

```bash
make
```

Useful narrower commands:

```bash
bun test
bun run --filter ./packages/coder build
bunx oxfmt --write path/to/changed-file.ts
```

CI performs `bun install` followed by `make` on Ubuntu.

## Repository layout

| Path                                              | Purpose                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| `packages/coder`                                  | Interactive application and host-specific extensions   |
| `packages/coder/src/index.ts`                     | Runtime assembly and active extension registration     |
| `packages/coder/src/workspace`                    | Agent task provisioning, registry, and TUI integration |
| `packages/coder/src/extensions/command-policy.ts` | Allowed and banned host commands                       |
| `packages/coder/src/extensions/write-guard`       | Protection against unsafe whole-file overwrites        |
| `packages/coder/src/extensions/git-commit`        | Checked, non-default-branch commits                    |
| `packages/command-policy`                         | Reusable shell parsing and policy-matching engine      |
| `packages/fix-ci`                                 | Active push, GitHub CI, and PR automation              |
| `Makefile`                                        | Canonical build and test entry point                   |
| `flake.nix`                                       | Nix development and runtime packaging                  |
| `AGENTS.md`                                       | Detailed routing and change guidance for coding agents |

## Architecture

`packages/coder/src/index.ts` first selects or provisions a host-owned task
workspace, then creates Pi's services and interactive runtime in that worktree.
The workspace identity is checked again by commit and push workflows.

Extensions have two main integration patterns:

1. **Registered tools** expose explicit operations such as `git_commit`.
2. **Event hooks** intercept operations, such as command-policy checks and the
   write guard.

Keep Pi SDK integration in package entry points. Put independently testable
behavior in adjacent helpers such as `logic.ts`, and add colocated
`*.test.ts` regression tests.

## Safety model

The command policy permits project-defined build, test, formatting, and
language-toolchain commands. It constrains operations where a stronger host
workflow exists:

- `cat`, `grep`, `find`, `sed`, and `tee` are replaced by Pi-native read,
  search, and edit tools.
- Recursive deletion and recursive permission changes are blocked.
- `sudo` and `doas` are blocked.
- Git is separately deny-by-default: inspection, staging, and restoration are
  allowed, while commits, synchronization, history changes, and branch
  lifecycle must use host-owned workflows.

When changing policy behavior, start in
`packages/coder/src/extensions/command-policy.ts`. Change the reusable matching
semantics only in `packages/command-policy`, and accompany behavior changes
with regression tests.

## Adding or changing an extension

1. Read the package entry point and its colocated tests.
2. Implement SDK registration in the entry-point or extension file.
3. Extract pure decisions into a nearby `logic.ts` module.
4. Register the extension factory in `packages/coder/src/index.ts`.
5. Run the narrowest relevant test, then `make`.

Adding a package to `packages/coder/package.json` does not activate it by
itself.

## Troubleshooting

### `No API key found`

Run the agent interactively and use `/login` to configure the required
provider. Remember that the nested exploration session currently requires
OpenAI access specifically.

### A shell command is blocked

Use the alternative named in the policy error. Prefer Pi's `read`, `edit`, and
`write` tools for file operations and `rg`/`fd` for shell search and discovery.
If a command truly belongs in the allowlist, add the narrowest command,
subcommand, and flag rules possible rather than allowing a broad executable.

### A large file cannot be written

Use targeted exact-text edits. New files and existing files of 50 lines or
fewer may still be written wholesale.

## Upstream documentation

- [Pi README](https://github.com/earendil-works/pi)
- [Bun documentation](https://bun.sh/docs)
