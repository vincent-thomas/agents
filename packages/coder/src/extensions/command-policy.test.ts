import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { test } from "node:test";
import { evaluateCommand } from "@vt-agent/command-policy";
import { validateManagedBunCommand } from "./command-policy-paths.ts";
import { commandPolicyEntries } from "./command-policy.ts";

function violation(command: string, cwd = process.cwd()) {
  return evaluateCommand(command, commandPolicyEntries, validateManagedBunCommand, cwd);
}

test("allows bare make and selected targets only", () => {
  assert.equal(violation("make"), null);
  assert.equal(violation("make test"), null);
  assert.equal(violation("make format"), null);
  assert.ok(violation("make audit"));
  assert.ok(violation("make test EXTRA=1"));
});

test("allows bun tests with optional project-relative paths", () => {
  assert.equal(violation("bun test"), null);
  assert.equal(violation("bun test packages/coder/src/extensions/command-policy.test.ts"), null);
  assert.equal(
    violation(
      "bun test packages/coder/src/extensions/command-policy.test.ts packages/command-policy/matching.test.ts",
    ),
    null,
  );
  assert.ok(violation("bun test .."));
  assert.ok(violation(`bun test ../${basename(process.cwd())}/package.json`));
  assert.ok(violation(`bun test ${process.cwd()}/package.json`));
  assert.ok(violation("bun test --watch"));
  assert.ok(violation("bun test missing.test.ts"));
  assert.ok(violation("bun test package.json/.."));
  assert.ok(violation("bun test package.json/."));
  assert.ok(violation("bun test package.json/"));
});

test("allows oxfmt modes only with explicit project paths", () => {
  const policyPath = "packages/coder/src/extensions/command-policy.ts";
  assert.equal(violation(`bun x oxfmt --check ${policyPath}`), null);
  assert.equal(violation(`bun x oxfmt --write ${process.cwd()}/${policyPath}`), null);
  assert.ok(violation("bun x oxfmt --check"));
  assert.ok(violation('bun x oxfmt --write ""'));
  assert.ok(violation("bun x oxfmt --write .."));
  assert.ok(violation(`bun x oxfmt --list ${policyPath}`));
  assert.ok(violation("bun x oxfmt --write $HOME/outside.ts"));
});

test("supports quoted project paths without treating comments as paths", () => {
  const projectFixture = mkdtempSync(join(tmpdir(), "command-policy-project-"));
  const spacedDirectory = join(projectFixture, "with space");
  mkdirSync(spacedDirectory);
  writeFileSync(join(spacedDirectory, "example.test.ts"), "");
  writeFileSync(join(projectFixture, "#"), "");
  writeFileSync(join(projectFixture, "$literal.test.ts"), "");
  writeFileSync(join(projectFixture, "[generated].ts"), "");

  try {
    assert.equal(violation('bun test "with space/example.test.ts"', projectFixture), null);
    assert.equal(
      violation('bun x oxfmt --write "with space/example.test.ts"', projectFixture),
      null,
    );
    assert.equal(violation('bun x oxfmt --check "#"', projectFixture), null);
    assert.equal(violation("bun test '$literal.test.ts'", projectFixture), null);
    assert.equal(violation("bun x oxfmt --check '[generated].ts'", projectFixture), null);
    assert.ok(violation("bun x oxfmt --check #", projectFixture));
    assert.ok(violation("bun test $literal.test.ts", projectFixture));
    assert.ok(violation("bun x oxfmt --check [generated].ts", projectFixture));
  } finally {
    rmSync(projectFixture, { recursive: true, force: true });
  }
});

test("blocks shell syntax that can inject unvalidated Bun paths", () => {
  const policyPath = "packages/coder/src/extensions/command-policy.ts";
  assert.ok(violation("bun test $(echo ../outside.test.ts)"));
  assert.ok(violation(`bun x oxfmt --write ${policyPath} $(echo /etc/hosts)`));
  assert.ok(violation("bun test < /etc/hosts"));
  assert.ok(violation(`bun x oxfmt --check ${policyPath} > /tmp/oxfmt-output`));
  assert.ok(violation("BUN_OPTIONS=--preload=/tmp/setup.ts bun test"));
});

test("blocks symlink traversal outside the project", () => {
  const projectFixture = mkdtempSync(join(process.cwd(), ".command-policy-test-"));
  const outsideFixture = mkdtempSync(join(tmpdir(), "command-policy-test-"));
  const outsideChild = join(outsideFixture, "child");
  mkdirSync(outsideChild);
  writeFileSync(join(projectFixture, "outside.test.ts"), "");
  writeFileSync(join(outsideFixture, "outside.test.ts"), "");
  symlinkSync(outsideChild, join(projectFixture, "link"), "dir");
  symlinkSync(projectFixture, join(outsideChild, "reentry"), "dir");

  try {
    const link = relative(process.cwd(), join(projectFixture, "link"));
    const escapingPath = `${link}/../outside.test.ts`;
    assert.ok(violation(`bun test ${escapingPath}`));
    assert.ok(violation(`bun x oxfmt --write ${escapingPath}`));

    const reenteringPath = `${link}/reentry/outside.test.ts`;
    assert.ok(violation(`bun test ${reenteringPath}`));
    assert.ok(violation(`bun x oxfmt --write ${reenteringPath}`));
  } finally {
    rmSync(projectFixture, { recursive: true, force: true });
    rmSync(outsideFixture, { recursive: true, force: true });
  }
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
  assert.equal(violation("git status --branch"), null);
  assert.equal(violation("git diff --check"), null);
  assert.equal(violation("git log -5"), null);
  assert.equal(violation("git add -- src/index.ts"), null);
  assert.equal(violation("git restore -- src/index.ts"), null);
});

test("retains direct safety bans before the workspace fallback", () => {
  assert.ok(violation("sudo make install"));
  assert.match(violation("rm -rf build")?.reason ?? "", /Use git rm/);
  assert.ok(violation("cat .env"));
});
