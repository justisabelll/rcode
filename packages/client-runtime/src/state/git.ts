import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createGitEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    pullRequestResolution: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:resolve-pull-request",
      tag: WS_METHODS.gitResolvePullRequest,
    }),
    preparePullRequestThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:prepare-pull-request-thread",
      tag: WS_METHODS.gitPreparePullRequestThread,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    forkSyncStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:fork-sync-status",
      tag: WS_METHODS.gitForkSyncStatus,
      staleTimeMs: 10_000,
    }),
    forkSyncSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:fork-sync-setup",
      tag: WS_METHODS.gitForkSyncSetup,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    forkSyncUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:fork-sync-update",
      tag: WS_METHODS.gitForkSyncUpdate,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    forkSyncPush: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:fork-sync-push",
      tag: WS_METHODS.gitForkSyncPush,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    forkSyncResume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:fork-sync-resume",
      tag: WS_METHODS.gitForkSyncResume,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    forkSyncAbort: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:fork-sync-abort",
      tag: WS_METHODS.gitForkSyncAbort,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    forkSyncAgentPrompt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:fork-sync-agent-prompt",
      tag: WS_METHODS.gitForkSyncAgentPrompt,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
