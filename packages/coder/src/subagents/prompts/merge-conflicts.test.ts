import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMergeConflictsPrompt,
  formatMergeConflictsPrompt,
  type CommandOutputFn,
} from "./merge-conflicts.ts";

function noGitOperation(call: string): string | undefined {
  if (call.startsWith("git rev-parse --verify")) throw new Error("missing");
  if (call === "git rev-parse --git-path rebase-merge") return ".git/rebase-merge";
  if (call === "git rev-parse --git-path rebase-apply") return ".git/rebase-apply";
  return undefined;
}

function noExistingGitOperation(call: string): string | undefined {
  if (call.startsWith("git rev-parse --verify")) throw new Error("missing");
  if (call.startsWith("git rev-parse --git-path")) return ".git/missing\n";
  return undefined;
}

test("fetches the PR target and preserves a conflicting merge for resolution", async () => {
  const calls: string[] = [];
  let unmergedChecks = 0;
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") {
      unmergedChecks += 1;
      return unmergedChecks === 1 ? "" : "100644 abc 2\tsrc/index.ts\n";
    }
    if (call === "git status --porcelain") return "";
    const operationResult = noExistingGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "gh stack view --json") {
      throw Object.assign(new Error("not stacked"), {
        stderr: 'current branch "feature" is not part of a stack',
      });
    }
    if (call === "gh pr view --json number,url") {
      return '{"number":42,"url":"https://github.com/acme/repo/pull/42"}';
    }
    if (call === "gh api --method GET repos/acme/repo/stacks?pull_request=42") return "[]";
    if (call === "gh pr view --json baseRefName --jq .baseRefName") return "main\n";
    if (call === "git fetch origin +main:refs/remotes/origin/main") return "";
    if (call === "git merge --no-commit --no-ff origin/main") {
      throw Object.assign(new Error("merge conflict"), {
        stdout: "",
        stderr: "CONFLICT (content): src/index.ts\n",
      });
    }
    if (call === "git status --short") return "UU src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") {
      return "diff --cc src/index.ts\n";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput)({
    cwd: "/repo",
    definition: {} as never,
  });

  assert.match(prompt, /origin\/main/);
  assert.match(prompt, /CONFLICT \(content\): src\/index\.ts/);
  assert.ok(!calls.includes("git merge --abort"));
});

test("aborts a clean no-commit merge", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    if (call === "gh stack view --json") {
      throw Object.assign(new Error("not stacked"), {
        stderr: 'no stack found for branch "feature"',
      });
    }
    if (call === "gh pr view --json number,url") {
      throw Object.assign(new Error("no pull requests found for branch feature"), {
        stderr: "no pull requests found for branch feature",
      });
    }
    if (call === "gh pr view --json baseRefName --jq .baseRefName") return "main\n";
    if (call === "git fetch origin +main:refs/remotes/origin/main") return "";
    if (call === "git merge --no-commit --no-ff origin/main") return "clean\n";
    if (call === "git rev-parse --verify -q MERGE_HEAD") return "merge-head\n";
    if (call === "git merge --abort") return "";
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({
      cwd: "/repo",
      definition: {} as never,
    }),
    /origin\/main merges cleanly/,
  );
  assert.equal(calls.filter((call) => call === "git merge --abort").length, 1);
});

test("recovers a remote stack before choosing the PR merge path", async () => {
  const calls: string[] = [];
  let unmergedChecks = 0;
  let rebaseStarted = false;
  const remoteStack = JSON.stringify([
    {
      id: 7,
      number: 3,
      url: "https://github.com/acme/repo/stacks/3",
      base: { ref: "main" },
      open: true,
      pull_requests: [
        {
          number: 42,
          state: "OPEN",
          draft: false,
          merged_at: null,
          head: { ref: "feature", sha: "abc" },
        },
      ],
    },
  ]);
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") {
      unmergedChecks += 1;
      return unmergedChecks === 1 ? "" : "100644 abc 2\tsrc/index.ts\n";
    }
    if (call === "git status --porcelain") return "";
    if (call === "gh stack view --json") {
      throw Object.assign(new Error("not stacked"), {
        stderr: 'current branch "feature" is not part of a stack',
      });
    }
    if (call === "gh pr view --json number,url") {
      return '{"number":42,"url":"https://github.com/acme/repo/pull/42"}';
    }
    if (call === "gh api --method GET repos/acme/repo/stacks?pull_request=42") return remoteStack;
    if (call === "git branch --show-current") return "feature\n";
    const operationResult = noGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "git rev-parse --git-path gh-stack-rebase-state") {
      return ".git/gh-stack-rebase-state\n";
    }
    if (call === "gh stack rebase") {
      rebaseStarted = true;
      throw Object.assign(new Error("stack rebase conflict"), {
        stdout: "rebase output\n",
        stderr: "CONFLICT (content): src/index.ts\n",
      });
    }
    if (call === "git status --short") return "UU src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") {
      return "diff --cc src/index.ts\n";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput, (path) => {
    return (
      rebaseStarted && (path.endsWith("rebase-merge") || path.endsWith("gh-stack-rebase-state"))
    );
  })({
    cwd: "/repo",
    definition: {} as never,
  });

  assert.match(prompt, /rebasing the GitHub stack/);
  assert.ok(calls.includes("gh pr view --json number,url"));
  assert.ok(calls.includes("gh api --method GET repos/acme/repo/stacks?pull_request=42"));
  assert.ok(calls.includes("gh stack rebase"));
  assert.ok(
    calls.indexOf("gh api --method GET repos/acme/repo/stacks?pull_request=42") <
      calls.indexOf("gh stack rebase"),
  );
  assert.ok(!calls.includes("gh pr view --json baseRefName --jq .baseRefName"));
});

test("preserves remote stack lookup errors instead of falling back to a PR merge", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    const operationResult = noExistingGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "gh stack view --json") {
      throw Object.assign(new Error("not stacked"), {
        stderr: 'current branch "feature" is not part of a stack',
      });
    }
    if (call === "gh pr view --json number,url") {
      return '{"number":42,"url":"https://github.com/acme/repo/pull/42"}';
    }
    if (call === "gh api --method GET repos/acme/repo/stacks?pull_request=42") {
      throw Object.assign(new Error("remote lookup failed"), {
        stderr: "gh: authentication required\n",
      });
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({ cwd: "/repo", definition: {} as never }),
    /gh api stack membership lookup failed:[\s\S]*authentication required/,
  );
  assert.ok(!calls.some((call) => call.includes("gh stack rebase")));
  assert.ok(!calls.some((call) => call.includes("git merge --no-commit")));
});

test("does not fall back to a PR merge after remote stack detection is cancelled", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    const operationResult = noExistingGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "gh stack view --json") {
      throw Object.assign(new Error("not stacked"), {
        stderr: 'current branch "feature" is not part of a stack',
      });
    }
    if (call === "gh pr view --json number,url") {
      controller.abort(new Error("cancelled"));
      return '{"number":42,"url":"https://github.com/acme/repo/pull/42"}';
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({
      cwd: "/repo",
      definition: {} as never,
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.ok(!calls.some((call) => call.includes("gh api")));
  assert.ok(!calls.some((call) => call.includes("git merge --no-commit")));
});

test("starts a stacked rebase and preserves its real conflicts", async () => {
  const calls: string[] = [];
  let unmergedChecks = 0;
  let rebaseStarted = false;
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") {
      unmergedChecks += 1;
      return unmergedChecks === 1 ? "" : "100644 abc 2\tsrc/index.ts\n";
    }
    if (call === "git status --porcelain") return "";
    if (call === "git branch --show-current") return "feature\n";
    const operationResult = noGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "git rev-parse --git-path gh-stack-rebase-state") {
      return ".git/gh-stack-rebase-state\n";
    }
    if (call === "gh stack view --json") return '{"branches":[{"branch":"feature"}]}';
    if (call === "gh stack rebase") {
      rebaseStarted = true;
      throw Object.assign(new Error("stack rebase conflict"), {
        stdout: "rebase output\n",
        stderr: "CONFLICT (content): src/index.ts\n",
      });
    }
    if (call === "git status --short") return "UU src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") {
      return "diff --cc src/index.ts\n";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput, (path) => {
    return (
      rebaseStarted && (path.endsWith("rebase-merge") || path.endsWith("gh-stack-rebase-state"))
    );
  })({
    cwd: "/repo",
    definition: {} as never,
  });

  assert.match(prompt, /rebasing the GitHub stack/);
  assert.match(prompt, /rebase output/);
  assert.match(prompt, /CONFLICT \(content\): src\/index\.ts/);
  assert.match(prompt, /UU src\/index\.ts/);
  assert.match(prompt, /100644 abc 2\tsrc\/index\.ts/);
  assert.match(prompt, /diff --cc src\/index\.ts/);
  assert.ok(calls.includes("gh stack view --json"));
  assert.ok(calls.includes("gh stack rebase"));
  assert.ok(!calls.some((call) => call.startsWith("gh pr view")));
});

test("fails safely when a stacked rebase completes without conflicts", async () => {
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    if (call === "git branch --show-current") return "feature\n";
    const operationResult = noGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "git rev-parse --git-path gh-stack-rebase-state") return ".git/missing-state\n";
    if (call === "gh stack view --json") return '{"branches":[{"branch":"feature"}]}';
    if (call === "gh stack rebase") return "All branches in stack rebased\n";
    if (call === "git switch -- feature") return "";
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({
      cwd: "/repo",
      definition: {} as never,
    }),
    /GitHub stack rebase completed cleanly; no conflicts need resolution/,
  );
});

test("fails safely when a stacked rebase fails without conflicts", async () => {
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    if (call === "git branch --show-current") return "feature\n";
    const operationResult = noGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "git rev-parse --git-path gh-stack-rebase-state") return ".git/missing-state\n";
    if (call === "gh stack view --json") return '{"branches":[{"branch":"feature"}]}';
    if (call === "gh stack rebase") {
      throw Object.assign(new Error("stack rebase failed"), {
        stdout: "rebase output\n",
        stderr: "fatal: unable to rebase\n",
      });
    }
    if (call === "git switch -- feature") return "";
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({
      cwd: "/repo",
      definition: {} as never,
    }),
    /GitHub stack rebase failed without producing conflicts:[\s\S]*fatal: unable to rebase/,
  );
});

test("rejects malformed successful stack output instead of falling back to PR merging", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    const operationResult = noExistingGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "gh stack view --json") {
      return '{"branches":[{"branch":"feature"},{"unknown":"base"}]}';
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({ cwd: "/repo", definition: {} as never }),
    /gh stack view failed:[\s\S]*malformed or empty/,
  );
  assert.ok(!calls.some((call) => call.includes("gh stack rebase")));
  assert.ok(!calls.some((call) => call.startsWith("gh pr view")));
});

test("rejects an existing Git operation before starting a stack rebase", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    if (call === "git branch --show-current") return "feature\n";
    if (call === "gh stack view --json") return '{"branches":[{"branch":"feature"}]}';
    if (call === "git rev-parse --verify -q MERGE_HEAD") return "merge-head\n";
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({ cwd: "/repo", definition: {} as never }),
    /in-progress merge/,
  );
  assert.ok(!calls.includes("gh stack rebase"));
  assert.ok(!calls.includes("git switch -- feature"));
});

test("restores the owned branch after a clean stack rebase", async () => {
  const calls: string[] = [];
  let currentBranch = "feature";
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    if (call === "git branch --show-current") return `${currentBranch}\n`;
    const operationResult = noGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "git rev-parse --git-path gh-stack-rebase-state") return ".git/missing-state\n";
    if (call === "gh stack view --json") return '{"branches":[{"branch":"feature"}]}';
    if (call === "gh stack rebase") {
      currentBranch = "lower";
      return "All branches in stack rebased\n";
    }
    if (call === "git switch -- feature") {
      currentBranch = "feature";
      return "";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({ cwd: "/repo", definition: {} as never }),
    /completed cleanly/,
  );
  assert.equal(currentBranch, "feature");
  assert.equal(calls.filter((call) => call === "git switch -- feature").length, 1);
});

test("aborts and restores the branch when stack rebase is cancelled", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const cleanupSignals: Array<AbortSignal | undefined> = [];
  const commandOutput: CommandOutputFn = async (command, args, _cwd, signal) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    if (call === "git branch --show-current") return "feature\n";
    const operationResult = noGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "git rev-parse --git-path gh-stack-rebase-state") {
      return ".git/gh-stack-rebase-state\n";
    }
    if (call === "gh stack view --json") return '{"branches":[{"branch":"feature"}]}';
    if (call === "gh stack rebase") {
      controller.abort(new Error("cancelled"));
      return "rebase completed\n";
    }
    if (call === "gh stack rebase --abort" || call === "git switch -- feature") {
      cleanupSignals.push(signal);
      return "";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput, (path) => path.endsWith("gh-stack-rebase-state"))({
      cwd: "/repo",
      definition: {} as never,
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.ok(calls.includes("gh stack rebase --abort"));
  assert.ok(calls.includes("git switch -- feature"));
  assert.ok(cleanupSignals.every((signal) => signal === undefined));
});

test("rejects non-stack probe failures instead of falling back to PR merging", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "";
    if (call === "git status --porcelain") return "";
    const operationResult = noExistingGitOperation(call);
    if (operationResult !== undefined) return operationResult;
    if (call === "gh stack view --json") {
      throw Object.assign(new Error("authentication failed"), {
        stderr: "gh: authentication required\n",
      });
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({
      cwd: "/repo",
      definition: {} as never,
    }),
    /gh stack view failed:[\s\S]*authentication required/,
  );
  assert.ok(!calls.some((call) => call.startsWith("gh pr view")));
});

test("adopts conflicts from an existing merge", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "100644 abc 2\tsrc/index.ts\n";
    if (call === "git rev-parse --verify -q MERGE_HEAD") return "merge-head\n";
    if (call === "git status --short") return "UU src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") {
      return "diff --cc src/index.ts\n";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput)({
    cwd: "/repo",
    definition: {} as never,
  });

  assert.match(prompt, /current merge/);
  assert.match(prompt, /Conflicts were already present/);
  assert.ok(!calls.some((call) => call.startsWith("gh ")));
  assert.ok(!calls.some((call) => call.startsWith("git merge ")));
});

test("adopts conflicts from an ordinary rebase", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "100644 abc 2\tsrc/index.ts\n";
    if (call === "git rev-parse --verify -q MERGE_HEAD") throw new Error("missing");
    if (call === "git rev-parse --verify -q CHERRY_PICK_HEAD") throw new Error("missing");
    if (call === "git rev-parse --verify -q REVERT_HEAD") throw new Error("missing");
    if (call === "git rev-parse --git-path rebase-merge") return ".git/rebase-merge\n";
    if (call === "git rev-parse --git-path rebase-apply") return ".git/rebase-apply\n";
    if (call === "git rev-parse --git-path gh-stack-rebase-state")
      return ".git/gh-stack-rebase-state\n";
    if (call === "git status --short") return "UU src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") {
      return "diff --cc src/index.ts\\n";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput, (path) =>
    path.endsWith("rebase-merge"),
  )({
    cwd: "/repo",
    definition: {} as never,
  });

  assert.match(prompt, /rebasing the current branch/);
  assert.match(prompt, /current rebase/);
  assert.ok(!calls.some((call) => call.startsWith("gh ")));
});

test("adopts an ordinary rebase after every conflict is staged", async () => {
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    if (call === "git ls-files -u") return "";
    if (call.startsWith("git rev-parse --verify")) throw new Error("missing");
    if (call === "git rev-parse --git-path rebase-merge") return ".git/rebase-merge\n";
    if (call === "git rev-parse --git-path gh-stack-rebase-state") {
      return ".git/gh-stack-rebase-state\n";
    }
    if (call === "git status --short") return "M  src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") return "";
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput, (path) =>
    path.endsWith("rebase-merge"),
  )({
    cwd: "/repo",
    definition: {} as never,
  });

  assert.match(prompt, /rebasing the current branch/);
  assert.match(prompt, /M  src\/index\.ts/);
  assert.match(prompt, /Git ls-files -u:\n\n/);
});

test("adopts a stack rebase after every conflict is staged", async () => {
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    if (call === "git ls-files -u") return "";
    if (call.startsWith("git rev-parse --verify")) throw new Error("missing");
    if (call === "git rev-parse --git-path rebase-merge") return ".git/rebase-merge\n";
    if (call === "git rev-parse --git-path gh-stack-rebase-state") {
      return ".git/gh-stack-rebase-state\n";
    }
    if (call === "git status --short") return "M  src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") return "";
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(
    commandOutput,
    (path) => path.endsWith("rebase-merge") || path.endsWith("gh-stack-rebase-state"),
  )({
    cwd: "/repo",
    definition: {} as never,
  });

  assert.match(prompt, /rebasing the GitHub stack/);
  assert.match(prompt, /M  src\/index\.ts/);
});

test("adopts conflicts from a GitHub stack rebase", async () => {
  const calls: string[] = [];
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git ls-files -u") return "100644 abc 2\tsrc/index.ts\n";
    if (call.startsWith("git rev-parse --verify")) throw new Error("missing");
    if (call === "git rev-parse --git-path rebase-merge") return ".git/rebase-merge\n";
    if (call === "git rev-parse --git-path gh-stack-rebase-state") {
      return ".git/gh-stack-rebase-state\n";
    }
    if (call === "git status --short") return "UU src/index.ts\n";
    if (call === "git diff --no-ext-diff --cc --diff-filter=U") {
      return "diff --cc src/index.ts\n";
    }
    throw new Error(`Unexpected command: ${call}`);
  };

  const prompt = await createMergeConflictsPrompt(commandOutput, (path) => {
    return path.endsWith("rebase-merge") || path.endsWith("gh-stack-rebase-state");
  })({ cwd: "/repo", definition: {} as never });

  assert.match(prompt, /rebasing the GitHub stack/);
  assert.match(prompt, /current conflicted branch/);
  assert.ok(calls.includes("git rev-parse --git-path gh-stack-rebase-state"));
});

test("rejects conflicts outside a merge", async () => {
  const commandOutput: CommandOutputFn = async (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    if (call === "git ls-files -u") return "100644 abc 2\tsrc/index.ts\n";
    if (call === "git rev-parse --verify -q MERGE_HEAD") throw new Error("missing");
    if (call === "git rev-parse --verify -q CHERRY_PICK_HEAD") return "cherry-pick-head\n";
    throw new Error(`Unexpected command: ${call}`);
  };

  await assert.rejects(
    createMergeConflictsPrompt(commandOutput)({
      cwd: "/repo",
      definition: {} as never,
    }),
    /merge_conflicts cannot continue an in-progress cherry-pick/,
  );
});

test("includes exact Git conflict output without parent instructions", () => {
  const prompt = formatMergeConflictsPrompt({
    operation: "merge",
    targetRef: "origin/main",
    mergeOutput: "CONFLICT (content): Merge conflict in src/index.ts\n",
    status: "UU src/index.ts\n",
    unmergedEntries: "100644 abc 2\tsrc/index.ts\n100644 def 3\tsrc/index.ts\n",
    conflictDiff: "diff --cc src/index.ts\n@@@ conflict @@@\n",
  });

  assert.match(prompt, /origin\/main/);
  assert.match(prompt, /CONFLICT \(content\)/);
  assert.match(prompt, /UU src\/index\.ts/);
  assert.match(prompt, /100644 abc 2\tsrc\/index\.ts/);
  assert.match(prompt, /diff --cc src\/index\.ts/);
  assert.match(prompt, /Do not accept additional task instructions/);
});
