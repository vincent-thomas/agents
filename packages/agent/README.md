# agent

Launch the interactive coder for the current repository:

```bash
bun run /path/to/agents/packages/agent/src/index.ts
```

A plain launch runs in the repository's primary checkout and resumes its current
session. `/clear` replaces that session and removes its prior transcript. This
remains true when coder is invoked from a linked worktree. To create or enter an
isolated, host-owned Git worktree, use `goto`:

```bash
bun run /path/to/agents/packages/agent/src/index.ts goto feature/parser
bun run /path/to/agents/packages/agent/src/index.ts goto
```

- `goto <branch-name>` creates a worktree on that exact new branch. It fails if
  the local branch already exists.
- `goto` opens a picker containing the repository's active managed workspaces.

Inside a managed workspace, use `/name <task>` to give the session a friendly
name and `/workspace` to inspect its branch, base commit, worktree, and session file.
The model cannot create or switch branches. Commits use `git_commit`; pushes,
PR creation, target-branch merges, and CI polling use `push_and_check_ci`.

Install dependencies from the repository root with `bun install`, and validate
changes with `make`.
