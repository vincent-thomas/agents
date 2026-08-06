import { currentBranch, getBranchSha } from "./git-utils.ts";
import {
  probeGhStackRemote,
  type GhStackCommandRunner,
  type GhStackRemoteStack,
  type GhStackView,
} from "./github-stack.ts";
import type { WorkspaceController, WorkspaceControllerSnapshot } from "./stack-workspace.ts";

type StackInspectionMember = {
  branch: string;
  /** SHA resolved from the local branch ref. */
  sha: string | null;
  /** SHA reported by the enriched local view, when present. */
  viewHead: string | null;
  /** Whether the enriched local view head agrees with the local ref. */
  localHeadVerification: "verified" | "mismatch" | "unavailable";
  localHeadMismatch: boolean;
  /** SHA reported by the authoritative remote PR, when matched by number. */
  remoteSha: string | null;
  shaMismatch: boolean;
  prNumber: number | null;
  prUrl: string | null;
  state: string | null;
  draft: boolean | null;
  needsRebase: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localStackMembers(
  view: GhStackView,
  shas: readonly (string | null)[],
): StackInspectionMember[] {
  return view.branches.map((branch, index) => {
    const sha = shas[index] ?? null;
    const viewHead = branch.head;
    const localHeadVerification =
      viewHead === null
        ? "unavailable"
        : sha === null
          ? "mismatch"
          : sha === viewHead
            ? "verified"
            : "mismatch";
    return {
      branch: branch.name,
      sha,
      viewHead,
      localHeadVerification,
      localHeadMismatch: localHeadVerification === "mismatch",
      remoteSha: null,
      shaMismatch: false,
      prNumber: branch.pr?.number ?? null,
      prUrl: branch.pr?.url ?? null,
      state: branch.pr?.state ?? null,
      draft: branch.pr?.draft ?? null,
      needsRebase: branch.needsRebase,
    };
  });
}

/** Overlay only authoritative remote PR fields; local branch SHA stays separate. */
function enrichRemoteMembers(
  local: readonly StackInspectionMember[],
  remote: GhStackRemoteStack,
): StackInspectionMember[] {
  const remoteByNumber = new Map(
    remote.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  return local.map((member) => {
    const remoteMember = member.prNumber === null ? undefined : remoteByNumber.get(member.prNumber);
    if (!remoteMember) return member;
    return {
      ...member,
      remoteSha: remoteMember.head.sha,
      state: remoteMember.state,
      draft: remoteMember.draft,
      shaMismatch: member.sha !== remoteMember.head.sha,
    };
  });
}

function aggregateInspectionStatus(
  local: "synchronized" | "mismatch" | "partial",
  remote: "synchronized" | "mismatch" | "absent" | "unavailable" | "local-only",
  ownership: "synchronized" | "mismatch" | "unavailable",
): "synchronized" | "mismatch" | "partial" | "local-only" {
  if (local === "mismatch" || remote === "mismatch" || ownership === "mismatch") return "mismatch";
  if (remote === "local-only") return "local-only";
  if (
    local === "partial" ||
    remote === "absent" ||
    remote === "unavailable" ||
    ownership === "unavailable"
  ) {
    return "partial";
  }
  return "synchronized";
}

function parsePullRequestRepository(urlText: string): { owner: string; repository: string } | null {
  try {
    const url = new URL(urlText);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 4 || parts[2] !== "pull" || !/^[1-9][0-9]*$/.test(parts[3])) return null;
    if (!parts[0] || !parts[1]) return null;
    return { owner: parts[0], repository: parts[1] };
  } catch {
    return null;
  }
}

function compareRemoteStack(
  local: readonly StackInspectionMember[],
  baseBranch: string | null,
  remote: GhStackRemoteStack,
): string[] {
  const mismatches: string[] = [];
  if (remote.base.ref !== baseBranch)
    mismatches.push(`base: local ${baseBranch ?? "<none>"}, remote ${remote.base.ref}`);
  if (remote.pullRequests.length !== local.length) {
    mismatches.push(`member count: local ${local.length}, remote ${remote.pullRequests.length}`);
  }
  const count = Math.max(local.length, remote.pullRequests.length);
  for (let index = 0; index < count; index++) {
    const localMember = local[index];
    const remoteMember = remote.pullRequests[index];
    if (!localMember || !remoteMember) continue;
    if (localMember.prNumber !== remoteMember.number) {
      mismatches.push(
        `member ${index + 1} PR: local ${localMember.prNumber ?? "<none>"}, remote #${remoteMember.number}`,
      );
    }
    if (localMember.branch !== remoteMember.head.ref) {
      mismatches.push(
        `member ${index + 1} branch: local ${localMember.branch}, remote ${remoteMember.head.ref}`,
      );
    }
    const remoteByPr =
      localMember.prNumber === null
        ? undefined
        : remote.pullRequests.find((pullRequest) => pullRequest.number === localMember.prNumber);
    if (remoteByPr && localMember.sha !== remoteByPr.head.sha) {
      mismatches.push(
        `member ${index + 1} SHA mismatch: local ${localMember.sha ?? "<missing>"}, remote ${remoteByPr.head.sha}`,
      );
    }
  }
  return mismatches;
}

/** Build the semantic local, remote, and workspace ownership stack report. */
export async function inspectStackReport(
  cwd: string,
  view: GhStackView,
  signal: AbortSignal | undefined,
  runner: GhStackCommandRunner,
  controller: WorkspaceController | undefined,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const shas = await Promise.all(
    view.branches.map((branch) => getBranchSha(cwd, branch.name, signal)),
  );
  let local = localStackMembers(view, shas);
  const baseBranch = view.trunk ?? view.base;
  const activeBranch = (await currentBranch(cwd, signal)) ?? view.currentBranch ?? "";
  const localMismatches = local.flatMap((member) => {
    if (!member.sha) return [`missing local SHA for ${member.branch}`];
    if (member.localHeadMismatch) {
      return [
        `local-view head mismatch for ${member.branch}: view ${member.viewHead ?? "<missing>"}, local ${member.sha}`,
      ];
    }
    return [];
  });
  const localVerificationUnavailable = local.flatMap((member) =>
    member.localHeadVerification === "unavailable"
      ? [`local-view head verification unavailable for ${member.branch}`]
      : [],
  );

  let remoteStatus: "synchronized" | "mismatch" | "absent" | "unavailable" | "local-only";
  let remoteStack: GhStackRemoteStack | undefined;
  let remoteMismatches: string[] = [];
  const firstUrl = view.branches.find((branch) => branch.pr?.url)?.pr?.url ?? null;
  if (!firstUrl) {
    remoteStatus = "local-only";
  } else {
    const repository = parsePullRequestRepository(firstUrl);
    const firstPr = view.branches.find((branch) => branch.pr?.url)?.pr?.number;
    if (!repository || !firstPr) {
      remoteStatus = "unavailable";
      remoteMismatches = ["could not parse the repository from the local PR URL"];
    } else {
      const remoteProbe = await probeGhStackRemote(
        cwd,
        repository.owner,
        repository.repository,
        firstPr,
        signal,
        runner,
      );
      if (remoteProbe.status === "found") {
        remoteStack = remoteProbe.stack;
        local = enrichRemoteMembers(local, remoteProbe.stack);
        remoteMismatches = compareRemoteStack(local, baseBranch, remoteProbe.stack);
        remoteStatus = remoteMismatches.length === 0 ? "synchronized" : "mismatch";
      } else {
        remoteStatus = remoteProbe.status === "absent" ? "absent" : "unavailable";
        if (remoteProbe.status === "error") remoteMismatches = [remoteProbe.output];
      }
    }
  }

  let ownershipStatus: "synchronized" | "mismatch" | "unavailable" = "unavailable";
  let ownershipMismatches: string[] = [];
  let ownershipSnapshot: WorkspaceControllerSnapshot | undefined;
  if (controller) {
    try {
      ownershipSnapshot = await controller.snapshot(cwd);
      if (
        ownershipSnapshot.activeBranch !== activeBranch ||
        JSON.stringify(ownershipSnapshot.branches) !==
          JSON.stringify(view.branches.map((branch) => branch.name)) ||
        ownershipSnapshot.baseBranch !== baseBranch
      ) {
        ownershipStatus = "mismatch";
        if (ownershipSnapshot.activeBranch !== activeBranch)
          ownershipMismatches.push("active branch");
        if (
          JSON.stringify(ownershipSnapshot.branches) !==
          JSON.stringify(view.branches.map((branch) => branch.name))
        ) {
          ownershipMismatches.push("ordered members");
        }
        if (ownershipSnapshot.baseBranch !== baseBranch) ownershipMismatches.push("base branch");
      } else {
        ownershipStatus = "synchronized";
      }
    } catch (error: unknown) {
      ownershipMismatches = [errorMessage(error)];
    }
  }

  const localStatus: "synchronized" | "mismatch" | "partial" =
    localMismatches.length > 0
      ? "mismatch"
      : localVerificationUnavailable.length > 0
        ? "partial"
        : "synchronized";
  const activeIndex = view.branches.findIndex((branch) => branch.name === activeBranch);
  const descendants =
    activeIndex >= 0 ? view.branches.slice(activeIndex + 1).map((branch) => branch.name) : [];
  const lines = [
    `Base: ${baseBranch ?? "<unknown>"}`,
    `Active: ${activeBranch || "<unknown>"}`,
    ...local.map((member, index) => {
      const branch = view.branches[index];
      const pr = member.prNumber === null ? "no PR" : `PR #${member.prNumber}`;
      const state = member.state ?? "state unknown";
      const draft = member.draft === null ? "draft unknown" : member.draft ? "draft" : "ready";
      const localSha = member.sha ? member.sha.slice(0, 8) : "<missing SHA>";
      const remoteSha = member.remoteSha ? member.remoteSha.slice(0, 8) : null;
      const shaText = remoteSha
        ? `${localSha}${member.shaMismatch ? ` (remote ${remoteSha}; SHA mismatch)` : ` (remote ${remoteSha})`}`
        : localSha;
      const viewHeadText =
        member.localHeadVerification === "unavailable"
          ? "; local-view head verification unavailable"
          : member.localHeadMismatch
            ? "; local-view head mismatch"
            : "";
      return `${branch.isCurrent || member.branch === activeBranch ? "*" : "-"} ${member.branch} ${pr} @ ${shaText}${viewHeadText} — ${state}, ${draft}, ${member.needsRebase ? "needs rebase" : "no rebase needed"}`;
    }),
    `A commit on ${activeBranch || "the active branch"} will restack descendants: ${descendants.length > 0 ? descendants.join(", ") : "none"}.`,
    `Remote: ${remoteStatus}; ownership: ${ownershipStatus}.`,
  ];
  return {
    text: lines.join("\n"),
    details: {
      status: aggregateInspectionStatus(localStatus, remoteStatus, ownershipStatus),
      local: {
        status: localStatus,
        baseBranch,
        activeBranch,
        members: local,
        mismatches: localMismatches,
        verificationUnavailable: localVerificationUnavailable,
      },
      remote: {
        status: remoteStatus,
        stack: remoteStack,
        mismatches: remoteMismatches,
      },
      ownership: {
        status: ownershipStatus,
        snapshot: ownershipSnapshot,
        mismatches: ownershipMismatches,
      },
      descendants,
    },
  };
}
