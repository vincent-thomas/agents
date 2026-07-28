# agent

The interactive coder runs each task in a host-owned Git branch and isolated
worktree. Launch it from the repository the task should start from:

```bash
bun run /path/to/agents/packages/agent/src/index.ts
```

The first launch creates an `agent/<uuid>` branch. Later launches resume the
only active task automatically or show a picker when several tasks exist.

```bash
bun run /path/to/agents/packages/agent/src/index.ts --resume
bun run /path/to/agents/packages/agent/src/index.ts --continue
bun run /path/to/agents/packages/agent/src/index.ts --new
```

- `--resume` opens the task picker, including an explicit **Start a new task** choice.
- `--continue` resumes the most recently updated active task.
- `--new` explicitly provisions another branch and worktree.

Inside Pi, use `/name <task>` to give the session a friendly task name and
`/workspace` to inspect its branch, base commit, worktree, and session file.
The model cannot create or switch branches. Commits use `git_commit`; pushes,
PR creation, target-branch merges, and CI polling use `push_and_check_ci`.

Install dependencies from the repository root with `bun install`, and validate
changes with `make`.
