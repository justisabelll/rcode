import { useMemo, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, GitForkSyncAgentPromptResult } from "@t3tools/contracts";
import {
  CheckIcon,
  CloudUploadIcon,
  BotIcon,
  GitBranchPlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "~/lib/icons";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import {
  useForkSyncAbortAction,
  useForkSyncAgentPromptAction,
  useForkSyncPushAction,
  useForkSyncResumeAction,
  useForkSyncSetupAction,
  useForkSyncUpdateAction,
} from "~/lib/sourceControlActions";
import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import {
  describeForkSyncStatus,
  forkSyncActionDialogCopy,
  type ForkSyncAction,
} from "./ForkSyncControl.logic";

interface ForkSyncControlProps {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly compact?: boolean;
  readonly autoLoad?: boolean;
  readonly onLaunchAgentPrompt?: (result: GitForkSyncAgentPromptResult) => Promise<boolean>;
}

function statusToneClassName(tone: ReturnType<typeof describeForkSyncStatus>["tone"]): string {
  if (tone === "success") return "text-success";
  if (tone === "warning") return "text-warning";
  if (tone === "danger") return "text-destructive";
  return "text-muted-foreground";
}

function ForkSyncStatusIcon({
  tone,
  className,
}: {
  readonly tone: ReturnType<typeof describeForkSyncStatus>["tone"];
  readonly className?: string;
}) {
  if (tone === "success") return <CheckIcon className={className} aria-hidden />;
  if (tone === "warning" || tone === "danger") {
    return <TriangleAlertIcon className={className} aria-hidden />;
  }
  return <GitBranchPlusIcon className={className} aria-hidden />;
}

function actionIcon(action: ForkSyncAction) {
  if (action === "setup") return <GitBranchPlusIcon className="size-3.5" aria-hidden />;
  if (action === "push") return <CloudUploadIcon className="size-3.5" aria-hidden />;
  if (action === "abort") return <Undo2Icon className="size-3.5" aria-hidden />;
  if (action === "agent") return <BotIcon className="size-3.5" aria-hidden />;
  return <RefreshCwIcon className="size-3.5" aria-hidden />;
}

export function ForkSyncControl({
  environmentId,
  cwd,
  compact = false,
  autoLoad = true,
  onLaunchAgentPrompt,
}: ForkSyncControlProps) {
  const [pendingAction, setPendingAction] = useState<ForkSyncAction | null>(null);
  const [hasRequestedStatus, setHasRequestedStatus] = useState(autoLoad);
  const scope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const query = useEnvironmentQuery(
    hasRequestedStatus && environmentId !== null && cwd !== null
      ? gitEnvironment.forkSyncStatus({
          environmentId,
          input: { cwd },
        })
      : null,
  );
  const setupAction = useForkSyncSetupAction(scope);
  const updateAction = useForkSyncUpdateAction(scope);
  const pushAction = useForkSyncPushAction(scope);
  const resumeAction = useForkSyncResumeAction(scope);
  const abortAction = useForkSyncAbortAction(scope);
  const agentPromptAction = useForkSyncAgentPromptAction(scope);
  const presentation = describeForkSyncStatus(query.data);
  const isRunning =
    setupAction.isPending ||
    updateAction.isPending ||
    pushAction.isPending ||
    resumeAction.isPending ||
    abortAction.isPending ||
    agentPromptAction.isPending;
  const action = presentation.action;
  const dialogCopy = pendingAction ? forkSyncActionDialogCopy(pendingAction) : null;

  const runAction = async (nextAction: ForkSyncAction) => {
    const toastId = toastManager.add({
      type: "loading",
      title: forkSyncActionDialogCopy(nextAction).confirmLabel,
      timeout: 0,
    });
    const result =
      nextAction === "setup"
        ? await setupAction.run()
        : nextAction === "update"
          ? await updateAction.run()
          : nextAction === "push"
            ? await pushAction.run()
            : nextAction === "resume"
              ? await resumeAction.run()
              : nextAction === "abort"
                ? await abortAction.run()
                : await agentPromptAction.run();

    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        toastManager.close(toastId);
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.update(
        toastId,
        stackedThreadToast({
          type: "error",
          title: "Fork sync failed",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }

    if ("prompt" in result.value) {
      const nextPresentation = describeForkSyncStatus(result.value.status);
      const launched = onLaunchAgentPrompt ? await onLaunchAgentPrompt(result.value) : false;
      if (!launched) {
        await navigator.clipboard.writeText(result.value.prompt);
      }
      query.refresh();
      toastManager.update(toastId, {
        type: "success",
        title: launched ? "Agent thread started" : "Agent prompt copied",
        description: nextPresentation.description,
        timeout: 8_000,
      });
      return;
    }

    const nextPresentation = describeForkSyncStatus(result.value);
    query.refresh();
    toastManager.update(toastId, {
      type: nextPresentation.tone === "danger" ? "error" : "success",
      title: nextPresentation.title,
      description: nextPresentation.description,
      timeout: 8_000,
    });
  };

  if (environmentId === null || cwd === null) {
    return null;
  }

  if (compact && presentation.action === null && presentation.tone === "neutral") {
    return null;
  }

  return (
    <>
      <div
        className={cn(
          "flex min-w-0 items-center gap-2",
          compact ? "px-2 py-1.5" : "rounded-md border border-border bg-muted/20 px-3 py-2",
        )}
      >
        <ForkSyncStatusIcon
          tone={presentation.tone}
          className={cn("size-3.5 shrink-0", statusToneClassName(presentation.tone))}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{presentation.title}</p>
          {!compact ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {query.error ?? presentation.description}
            </p>
          ) : null}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (!hasRequestedStatus) {
              setHasRequestedStatus(true);
              return;
            }
            query.refresh();
          }}
          disabled={query.isPending || isRunning}
          aria-label={hasRequestedStatus ? "Refresh fork sync status" : "Check fork sync status"}
        >
          <RefreshCwIcon className={cn("size-3", query.isPending && "animate-spin")} />
        </Button>
        {action && presentation.actionLabel ? (
          <Button
            size="xs"
            variant={compact ? "ghost" : "outline"}
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            disabled={isRunning}
            onClick={() => setPendingAction(action)}
          >
            {isRunning ? <Spinner className="size-3.5" /> : actionIcon(action)}
            {!compact ? (
              presentation.actionLabel
            ) : (
              <span className="sr-only">{presentation.actionLabel}</span>
            )}
          </Button>
        ) : null}
        {presentation.secondaryActions.map((secondaryAction) => (
          <Button
            key={secondaryAction.action}
            size={compact ? "icon-xs" : "xs"}
            variant="ghost"
            className={cn(
              "shrink-0",
              compact
                ? "size-6 text-muted-foreground hover:text-foreground"
                : "h-7 gap-1 px-2 text-xs",
            )}
            disabled={isRunning}
            onClick={() => setPendingAction(secondaryAction.action)}
          >
            {actionIcon(secondaryAction.action)}
            {compact ? (
              <span className="sr-only">{secondaryAction.label}</span>
            ) : (
              secondaryAction.label
            )}
          </Button>
        ))}
      </div>

      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => !open && setPendingAction(null)}
      >
        <DialogPopup>
          {dialogCopy ? (
            <>
              <DialogHeader>
                <DialogTitle>{dialogCopy.title}</DialogTitle>
                <DialogDescription>{dialogCopy.description}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setPendingAction(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={isRunning}
                  onClick={() => {
                    const actionToRun = pendingAction;
                    setPendingAction(null);
                    if (actionToRun) {
                      void runAction(actionToRun);
                    }
                  }}
                >
                  {dialogCopy.confirmLabel}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}
