import { hash } from "./fingerprint.ts";
import type { Action, ActionObservation, Evidence } from "./types.ts";

export function evidenceFromObservation(
  objectiveId: string,
  action: Action,
  observation: ActionObservation,
): Evidence[] {
  const base = {
    createdAt: observation.finishedAt,
    objectiveId,
    repositoryFingerprint: observation.repositoryFingerprintAfter,
    actionId: observation.actionId,
  };
  const evidence: Evidence[] = [
    {
      ...base,
      id: `${observation.actionId}:diff`,
      type: "diff",
      changedFiles: observation.changedFiles,
      unexpectedFiles: observation.unexpectedFiles,
      beforeFingerprint: observation.repositoryFingerprintBefore,
    },
  ];
  if (action.type === "command") {
    evidence.push({
      ...base,
      id: `${observation.actionId}:${action.test ? "test" : "command"}`,
      type: action.test ? "test" : "command",
      command: action.command,
      cwd: action.cwd ?? ".",
      exitCode: observation.exitCode ?? null,
      stdout: observation.stdout ?? "",
      stderr: observation.stderr ?? "",
      durationMs:
        new Date(observation.finishedAt).getTime() - new Date(observation.startedAt).getTime(),
      timedOut: observation.timedOut ?? false,
    });
  }
  if (action.type === "inspect") {
    const sources = JSON.parse(observation.stdout ?? "[]") as Array<{
      path: string;
      content: string;
    }>;
    for (const { path, content } of sources) {
      evidence.push({
        ...base,
        id: `${observation.actionId}:source:${path}`,
        type: "source",
        path,
        content,
        contentHash: hash(content),
      });
    }
  }
  return evidence;
}
