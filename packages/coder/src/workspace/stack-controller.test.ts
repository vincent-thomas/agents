import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceStackController } from "./stack-controller.ts";
import {
  createWorkspace,
  loadWorkspace,
  type WorkspaceStackClaim,
  type WorkspaceStore,
} from "./logic.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-stack-controller-test-"));
  const repo = join(root, "repo");
  const store: WorkspaceStore = { stateDir: join(root, "state") };
  execFileSync("git", ["init", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "tracked.txt"), "initial\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "Initial commit");
  return { repo, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function claim(activeBranch: string, workspaceBranch: string): WorkspaceStackClaim {
  return { baseBranch: "main", branches: ["stack/base", workspaceBranch], activeBranch };
}

test("controls stack ownership and restores a legacy snapshot", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/controller");
    const originalBranch = workspace.branch;
    git(repo, "branch", "stack/base");
    let currentWorkspace = workspace;
    const controller = createWorkspaceStackController({
      store,
      getWorkspace: () => currentWorkspace,
    });
    const before = await controller.snapshot(workspace.worktree);
    assert.deepEqual(before, {
      activeBranch: "feature/controller",
      branches: ["feature/controller"],
      baseBranch: null,
    });

    const stackClaim = claim("stack/base", originalBranch);
    await controller.validate(workspace.worktree, stackClaim);
    assert.deepEqual((await loadWorkspace(store, workspace.id)).stack, undefined);

    git(workspace.worktree, "switch", "stack/base");
    await controller.claim(workspace.worktree, stackClaim);
    assert.equal(currentWorkspace.branch, "stack/base");
    assert.deepEqual(currentWorkspace.stack, {
      baseBranch: "main",
      branches: ["stack/base", originalBranch],
    });

    const other = await createWorkspace(store, repo, "feature/other");
    const otherController = createWorkspaceStackController({
      store,
      getWorkspace: () => other,
    });
    await assert.rejects(
      otherController.validate(other.worktree, {
        baseBranch: "main",
        branches: ["feature/other", "stack/base"],
        activeBranch: "feature/other",
      }),
      /already owned by another workspace/,
    );

    git(workspace.worktree, "switch", originalBranch);
    await controller.restore(workspace.worktree, before);
    assert.equal(currentWorkspace.branch, originalBranch);
    assert.equal(currentWorkspace.stack, undefined);
  } finally {
    cleanup();
  }
});

test("rejects a wrong physical checkout and unsafe legacy multi-branch restore", async () => {
  const { repo, store, cleanup } = fixture();
  try {
    const workspace = await createWorkspace(store, repo, "feature/controller-wrong");
    git(repo, "branch", "stack/base");
    const controller = createWorkspaceStackController({
      store,
      getWorkspace: () => workspace,
    });
    await assert.rejects(
      controller.claim(workspace.worktree, claim("stack/base", workspace.branch)),
      /branch mismatch/,
    );
    await assert.rejects(
      controller.restore(workspace.worktree, {
        activeBranch: workspace.branch,
        branches: ["stack/base", workspace.branch],
        baseBranch: null,
      }),
      /multi-branch.*base branch/,
    );
  } finally {
    cleanup();
  }
});

test("clearly rejects controller operations without a current workspace", async () => {
  const { store, cleanup } = fixture();
  try {
    const controller = createWorkspaceStackController({ store, getWorkspace: () => undefined });
    await assert.rejects(controller.snapshot("/nowhere"), /No current managed workspace/);
  } finally {
    cleanup();
  }
});
