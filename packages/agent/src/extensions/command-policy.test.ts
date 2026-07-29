import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCommand } from "@vt-agent/command-policy";
import { commandPolicyEntries } from "./command-policy.ts";

function violation(command: string) {
  return evaluateCommand(command, commandPolicyEntries);
}

test("allows the project-defined validation boundary", () => {
  assert.equal(violation("make"), null);
});

test("keeps Git branch, history, and synchronization behind dedicated workflows", () => {
  for (const command of [
    "git push",
    "git commit -m test",
    "git checkout main",
    "git switch feature",
    "git reset --hard HEAD~1",
    "git rebase main",
    "git merge main",
    "git worktree add ../other feature",
    "git update-ref refs/heads/main HEAD",
  ]) {
    assert.ok(violation(command), command);
  }
});

test("allows explicit Git inspection and worktree checkpoint preparation", () => {
  assert.equal(violation("git status --short"), null);
  assert.equal(violation("git diff --check"), null);
  assert.equal(violation("git log -5"), null);
  assert.equal(violation("git add -- src/index.ts"), null);
  assert.equal(violation("git restore -- src/index.ts"), null);
});

test("retains direct safety bans before the workspace fallback", () => {
  assert.ok(violation("sudo make install"));
  assert.ok(violation("rm -rf build"));
  assert.ok(violation("cat .env"));
});
