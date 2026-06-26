import type { GitForkSyncStatusResult } from "@t3tools/contracts";

export type ForkSyncAction = "setup" | "update" | "push" | "resume" | "abort" | "agent";

export interface ForkSyncPresentation {
  readonly title: string;
  readonly description: string;
  readonly tone: "neutral" | "success" | "warning" | "danger";
  readonly action: ForkSyncAction | null;
  readonly actionLabel: string | null;
  readonly secondaryActions: ReadonlyArray<{
    readonly action: ForkSyncAction;
    readonly label: string;
  }>;
}

export function describeForkSyncStatus(
  status: GitForkSyncStatusResult | null,
): ForkSyncPresentation {
  if (!status) {
    return {
      title: "Fork sync unavailable",
      description: "Status has not loaded yet.",
      tone: "neutral",
      action: null,
      actionLabel: null,
      secondaryActions: [],
    };
  }

  switch (status._tag) {
    case "unsupported":
      return {
        title: "Fork sync unavailable",
        description: status.message,
        tone: status.reason === "missing_github_auth" ? "warning" : "neutral",
        action: null,
        actionLabel: null,
        secondaryActions: [],
      };
    case "setup_required":
      return {
        title: "Upstream setup required",
        description: `Add an upstream remote for ${status.parentRepository.nameWithOwner}.`,
        tone: "warning",
        action: "setup",
        actionLabel: "Add upstream",
        secondaryActions: [],
      };
    case "updates_available":
      return {
        title: "Upstream updates available",
        description: `${status.parentRepository.nameWithOwner} has updates for ${status.defaultBranch}.`,
        tone: "warning",
        action: "update",
        actionLabel: "Update fork",
        secondaryActions: [],
      };
    case "push_available":
      return {
        title: "Push available",
        description: `Push updated ${status.defaultBranch} to ${status.originRepository.nameWithOwner}.`,
        tone: "warning",
        action: "push",
        actionLabel: "Push fork",
        secondaryActions: status.syncSession ? [{ action: "abort", label: "Abort sync" }] : [],
      };
    case "diverged":
      return {
        title: "Branches diverged",
        description: "Start an isolated sync worktree to merge upstream safely.",
        tone: "warning",
        action: "update",
        actionLabel: "Start sync",
        secondaryActions: [],
      };
    case "conflicted":
      return {
        title: "Sync conflicts need resolution",
        description: `${status.syncSession?.conflictedFiles.length ?? 0} conflicted file(s) in the sync worktree.`,
        tone: "danger",
        action: "resume",
        actionLabel: "Resume",
        secondaryActions: [
          { action: "agent", label: "Agent assist" },
          { action: "abort", label: "Abort sync" },
        ],
      };
    case "blocked":
      return {
        title: "Fork sync blocked",
        description: status.message,
        tone: "danger",
        action: null,
        actionLabel: null,
        secondaryActions: [],
      };
    case "up_to_date":
      return {
        title: "Fork is up to date",
        description: `${status.defaultBranch} matches ${status.parentRepository.nameWithOwner}.`,
        tone: "success",
        action: null,
        actionLabel: null,
        secondaryActions: [],
      };
  }
}

export function forkSyncActionDialogCopy(action: ForkSyncAction): {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
} {
  switch (action) {
    case "setup":
      return {
        title: "Add upstream remote?",
        description: "This adds or reuses an upstream remote from the fork parent repository.",
        confirmLabel: "Add upstream",
      };
    case "update":
      return {
        title: "Update fork branch?",
        description:
          "This fast-forwards the local default branch from upstream only when Git confirms it is safe.",
        confirmLabel: "Update fork",
      };
    case "push":
      return {
        title: "Push updated fork?",
        description: "This pushes the local default branch to origin. It will not force-push.",
        confirmLabel: "Push fork",
      };
    case "resume":
      return {
        title: "Resume fork sync?",
        description:
          "This verifies the sync worktree has no unresolved conflicts and completes the merge if needed.",
        confirmLabel: "Resume",
      };
    case "abort":
      return {
        title: "Abort fork sync?",
        description:
          "This removes only the fork-sync worktree and branch created for this workflow.",
        confirmLabel: "Abort sync",
      };
    case "agent":
      return {
        title: "Use agent assistance?",
        description:
          "This starts a scoped agent thread when the current context supports it. Otherwise, it copies the conflict-resolution prompt.",
        confirmLabel: "Continue",
      };
  }
}
