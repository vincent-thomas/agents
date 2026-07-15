# Agent

A safety-focused coding agent built on the
[Pi coding agent](https://github.com/earendil-works/pi). This repository wraps
Pi with project-specific tools and policies for exploring code, editing files,
and creating verified Git commits.

## What it adds

The runtime in `packages/agent/src/index.ts` currently enables:

- **Command policy** — shell commands are denied by default. Approved commands,
  subcommands, and flags are defined explicitly.
- **Read-only exploration** — the `explore` tool delegates broad codebase
  questions to an isolated sub-agent that cannot edit files or run shell
  commands.
- **Write guard** — existing files longer than 50 lines cannot be replaced
  wholesale with the `write` tool; targeted `edit` operations are required.
- **Commit guard** — the `git_commit` tool runs pre-checks and refuses to commit
  on a default branch.
- **Working conventions** — the appended system prompt asks the agent to make
  focused changes, verify them, and keep a clean Git history.

The `packages/fix-ci` workspace contains a push/CI/PR extension, but it is **not
registered in the current runtime**. Do not assume a workspace dependency is an
active agent feature; `packages/agent/src/index.ts` is the source of truth.

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

Start the interactive agent in the directory you want it to operate on:

```bash
bun run packages/agent/src/index.ts
```

The process uses its current working directory as the agent workspace. To work
on another project without installing this repository there, run the entry
point by absolute path from that project's directory.

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
bun test packages/explorer/logic.test.ts
bun run --filter ./packages/agent build
bunx oxfmt --write path/to/changed-file.ts
```

CI performs `bun install` followed by `make` on Ubuntu.

## Repository layout

| Path                                              | Purpose                                                 |
| ------------------------------------------------- | ------------------------------------------------------- |
| `packages/agent`                                  | Interactive application and host-specific extensions    |
| `packages/agent/src/index.ts`                     | Runtime assembly and active extension registration      |
| `packages/agent/src/extensions/command-policy.ts` | Allowed and banned host commands                        |
| `packages/agent/src/extensions/write-guard`       | Protection against unsafe whole-file overwrites         |
| `packages/agent/src/extensions/git-commit`        | Checked, non-default-branch commits                     |
| `packages/command-policy`                         | Reusable shell parsing and policy-matching engine       |
| `packages/explorer`                               | Isolated read-only exploration sub-agent                |
| `packages/fix-ci`                                 | Push, GitHub CI, and PR automation (currently inactive) |
| `Makefile`                                        | Canonical build and test entry point                    |
| `flake.nix`                                       | Nix development and runtime packaging                   |
| `AGENTS.md`                                       | Detailed routing and change guidance for coding agents  |

## Architecture

`packages/agent/src/index.ts` creates Pi's services and interactive runtime. It
supplies extension factories through the resource loader, then starts an
`InteractiveMode` session rooted at the current directory.

Extensions have two main integration patterns:

1. **Registered tools** expose explicit operations such as `explore` and
   `git_commit`.
2. **Event hooks** intercept operations, such as command-policy checks and the
   write guard.

Keep Pi SDK integration in package entry points. Put independently testable
behavior in adjacent helpers such as `logic.ts`, and add colocated
`*.test.ts` regression tests.

## Safety model

The command policy is intentionally deny-by-default. Common read-only utilities
such as `rg`, `fd`, `jq`, and selected Git inspection commands are allowed.
Riskier operations are constrained or redirected to dedicated tools:

- `cat`, `grep`, `find`, `sed`, and `tee` are replaced by Pi-native read,
  search, and edit tools.
- Recursive deletion and recursive permission changes are blocked.
- `sudo`, `doas`, Python, Perl, and awk execution are blocked.
- Direct `git commit`, `git push`, and branch management are blocked.

When changing policy behavior, start in
`packages/agent/src/extensions/command-policy.ts`. Change the reusable matching
semantics only in `packages/command-policy`, and accompany behavior changes
with regression tests.

## Adding or changing an extension

1. Read the package entry point and its colocated tests.
2. Implement SDK registration in the entry-point or extension file.
3. Extract pure decisions into a nearby `logic.ts` module.
4. Register the extension factory in `packages/agent/src/index.ts`.
5. Run the narrowest relevant test, then `make`.

Adding a package to `packages/agent/package.json` does not activate it by
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
