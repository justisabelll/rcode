import type { GitForkSyncRepository, GitForkSyncStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { describeForkSyncStatus, forkSyncActionDialogCopy } from "./ForkSyncControl.logic";

const originRepository: GitForkSyncRepository = {
  nameWithOwner: "octocat/t3code",
  url: "https://github.com/octocat/t3code",
  sshUrl: "git@github.com:octocat/t3code.git",
  defaultBranch: "main",
};

const parentRepository: GitForkSyncRepository = {
  nameWithOwner: "pingdotgg/t3code",
  url: "https://github.com/pingdotgg/t3code",
  sshUrl: "git@github.com:pingdotgg/t3code.git",
  defaultBranch: "main",
};

function comparisonStatus<
  Tag extends Extract<
    GitForkSyncStatusResult["_tag"],
    "up_to_date" | "updates_available" | "push_available" | "diverged"
  >,
>(tag: Tag): Extract<GitForkSyncStatusResult, { _tag: Tag }> {
  return {
    _tag: tag,
    originRemote: "origin",
    originRepository,
    parentRepository,
    defaultBranch: "main",
    upstreamRemote: "upstream",
    localCommit: "1111111",
    originCommit: "1111111",
    upstreamCommit: "2222222",
    syncSession: null,
  } as Extract<GitForkSyncStatusResult, { _tag: Tag }>;
}

describe("describeForkSyncStatus", () => {
  it("maps setup_required to an upstream setup action", () => {
    assert.deepInclude(
      describeForkSyncStatus({
        _tag: "setup_required",
        originRemote: "origin",
        originRepository,
        parentRepository,
        defaultBranch: "main",
        upstreamRemote: null,
      }),
      {
        title: "Upstream setup required",
        tone: "warning",
        action: "setup",
        actionLabel: "Add upstream",
      },
    );
  });

  it("maps updates_available and push_available to separate actions", () => {
    assert.deepInclude(describeForkSyncStatus(comparisonStatus("updates_available")), {
      action: "update",
      actionLabel: "Update fork",
    });
    assert.deepInclude(describeForkSyncStatus(comparisonStatus("push_available")), {
      action: "push",
      actionLabel: "Push fork",
    });
  });

  it("maps divergent and conflicted states to isolated sync actions", () => {
    assert.deepInclude(describeForkSyncStatus(comparisonStatus("diverged")), {
      tone: "warning",
      action: "update",
      actionLabel: "Start sync",
    });
    assert.deepInclude(
      describeForkSyncStatus({
        ...comparisonStatus("diverged"),
        _tag: "conflicted",
        syncSession: {
          id: "octocat/t3code:main",
          branch: "t3/fork-sync/octocat-t3code/main",
          worktreePath: "/tmp/worktree",
          conflictedFiles: [{ path: "README.md" }],
        },
      }),
      {
        tone: "danger",
        action: "resume",
        actionLabel: "Resume",
      },
    );
  });

  it("offers abort as a secondary action for sync-session push states", () => {
    const presentation = describeForkSyncStatus({
      ...comparisonStatus("push_available"),
      syncSession: {
        id: "octocat/t3code:main",
        branch: "t3/fork-sync/octocat-t3code/main",
        worktreePath: "/tmp/worktree",
        conflictedFiles: [],
      },
    });

    assert.deepStrictEqual(presentation.secondaryActions, [
      { action: "abort", label: "Abort sync" },
    ]);
  });

  it("does not offer an action for unsupported states", () => {
    assert.deepInclude(
      describeForkSyncStatus({
        _tag: "unsupported",
        reason: "missing_github_auth",
        message: "GitHub CLI is not authenticated.",
      }),
      {
        tone: "warning",
        action: null,
      },
    );
  });
});

describe("forkSyncActionDialogCopy", () => {
  it("keeps fork-sync confirmation copy separate", () => {
    assert.equal(forkSyncActionDialogCopy("update").confirmLabel, "Update fork");
    assert.equal(forkSyncActionDialogCopy("push").confirmLabel, "Push fork");
    assert.equal(forkSyncActionDialogCopy("resume").confirmLabel, "Resume");
    assert.equal(forkSyncActionDialogCopy("abort").confirmLabel, "Abort sync");
    assert.equal(forkSyncActionDialogCopy("agent").confirmLabel, "Continue");
  });
});
