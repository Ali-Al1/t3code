import {
  EnvironmentId,
  MessageId,
  RunId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveContinuableRunId, presentThreadShellFromProjection } from "./ChatView.logic";
import { makeThreadProjectionFixture } from "../test-fixtures";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

function run(status: OrchestrationV2RunStatus, base: OrchestrationV2ThreadProjection) {
  return {
    id: RunId.make("run-1"),
    threadId: base.thread.id,
    ordinal: 1,
    providerInstanceId: base.thread.providerInstanceId,
    modelSelection: base.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message-run-1"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
}

const watchedPullRequest = {
  host: "github.com",
  repository: "acme/app",
  number: 1,
  url: "https://github.com/acme/app/pull/1",
  source: "agent" as const,
  snapshot: null,
  watch: {
    startedAt: "2026-01-01T00:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: "2026-01-01T00:00:00.000Z",
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  },
};

function projection(status: OrchestrationV2RunStatus, watched: boolean) {
  const base = makeThreadProjectionFixture();
  return {
    ...base,
    thread: { ...base.thread, ...(watched ? { pullRequests: [watchedPullRequest] } : {}) },
    runs: [run(status, base)],
  } as unknown as Parameters<typeof presentThreadShellFromProjection>[2];
}

describe("pull request watch holds", () => {
  it("gives a direct-link shell the watch roster its runtime parks on", () => {
    const shell = presentThreadShellFromProjection(
      EnvironmentId.make("environment-test"),
      makeThreadProjectionFixture().thread.id,
      projection("completed", true),
      { updatedAt: now, lastVisitedAt: null },
    );
    expect(shell.runtime?.status).toBe("idle");
    expect(shell.pendingBackgroundTasks).toEqual([
      expect.objectContaining({
        taskId: "pull-request-watch:github.com/acme/app#1",
        kind: "monitor",
        awaited: true,
      }),
    ]);
  });

  it("offers Continue for an interrupted run only when nothing holds the thread", () => {
    const held = projection("interrupted", true);
    expect(deriveContinuableRunId(held, null)).toBeNull();

    const unheld = projection("interrupted", false);
    expect(deriveContinuableRunId(unheld, null)).toBe(RunId.make("run-1"));
  });
});
