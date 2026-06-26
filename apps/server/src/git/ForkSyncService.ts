import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  GitCommandError,
  GitManagerError,
  type GitForkSyncAbortInput,
  type GitForkSyncAbortResult,
  type GitForkSyncAgentPromptInput,
  type GitForkSyncAgentPromptResult,
  type GitForkSyncConflictFile,
  type GitForkSyncPushInput,
  type GitForkSyncPushResult,
  type GitForkSyncRepository,
  type GitForkSyncResumeInput,
  type GitForkSyncResumeResult,
  type GitForkSyncSession,
  type GitForkSyncSetupInput,
  type GitForkSyncSetupResult,
  type GitForkSyncStatusInput,
  type GitForkSyncStatusResult,
  type GitForkSyncUpdateInput,
  type GitForkSyncUpdateResult,
  type GitManagerServiceError,
} from "@t3tools/contracts";
import {
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
} from "@t3tools/shared/git";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const DEFAULT_UPSTREAM_REMOTE = "upstream";
const SYNC_BRANCH_PREFIX = "t3/fork-sync";
const NON_INTERACTIVE_GIT_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);

export class ForkSyncService extends Context.Service<
  ForkSyncService,
  {
    readonly status: (
      input: GitForkSyncStatusInput,
    ) => Effect.Effect<GitForkSyncStatusResult, GitManagerServiceError>;
    readonly setup: (
      input: GitForkSyncSetupInput,
    ) => Effect.Effect<GitForkSyncSetupResult, GitManagerServiceError>;
    readonly update: (
      input: GitForkSyncUpdateInput,
    ) => Effect.Effect<GitForkSyncUpdateResult, GitManagerServiceError>;
    readonly push: (
      input: GitForkSyncPushInput,
    ) => Effect.Effect<GitForkSyncPushResult, GitManagerServiceError>;
    readonly resume: (
      input: GitForkSyncResumeInput,
    ) => Effect.Effect<GitForkSyncResumeResult, GitManagerServiceError>;
    readonly abort: (
      input: GitForkSyncAbortInput,
    ) => Effect.Effect<GitForkSyncAbortResult, GitManagerServiceError>;
    readonly agentPrompt: (
      input: GitForkSyncAgentPromptInput,
    ) => Effect.Effect<GitForkSyncAgentPromptResult, GitManagerServiceError>;
  }
>()("t3/git/ForkSyncService") {}

interface RemoteUrls {
  readonly name: string;
  readonly url: string;
}

interface ForkContext {
  readonly cwd: string;
  readonly originRemote: RemoteUrls;
  readonly originRepository: GitForkSyncRepository;
  readonly parentRepository: GitForkSyncRepository;
  readonly defaultBranch: string;
  readonly upstreamRemote: string | null;
}

interface ComparisonContext extends ForkContext {
  readonly localCommit: string | null;
  readonly originCommit: string;
  readonly upstreamCommit: string;
  readonly syncSession: GitForkSyncSession | null;
}

function unsupported(
  reason: Extract<GitForkSyncStatusResult, { _tag: "unsupported" }>["reason"],
  message: string,
): GitForkSyncStatusResult {
  return { _tag: "unsupported", reason, message };
}

function repositoryFromGitHub(
  repository: GitHubCli.GitHubRepositoryCloneUrls & { readonly defaultBranch: string },
): GitForkSyncRepository {
  return {
    nameWithOwner: repository.nameWithOwner,
    url: repository.url,
    sshUrl: repository.sshUrl,
    defaultBranch: repository.defaultBranch,
  };
}

function parseRemoteConfigOutput(stdout: string): ReadonlyArray<RemoteUrls> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^remote\.([^.]+)\.url\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, name = "", url = ""] = match;
    if (name.length > 0 && url.length > 0) {
      remotes.set(name, url);
    }
  }
  return Array.from(remotes.entries()).map(([name, url]) => ({ name, url }));
}

function sameRemoteUrl(left: string, right: string): boolean {
  return normalizeGitRemoteUrl(left) === normalizeGitRemoteUrl(right);
}

function remoteMatchesRepository(remote: RemoteUrls, repository: GitForkSyncRepository): boolean {
  return sameRemoteUrl(remote.url, repository.url) || sameRemoteUrl(remote.url, repository.sshUrl);
}

function isSshRemote(url: string): boolean {
  return /^(?:git@|ssh:\/\/)/i.test(url.trim());
}

function remoteUrlForOriginProtocol(originUrl: string, repository: GitForkSyncRepository): string {
  return isSshRemote(originUrl) ? repository.sshUrl : repository.url;
}

function slugForGitRef(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^[-/.]+|[-/.]+$/g, "");
  return slug.length > 0 ? slug : "default";
}

function syncSessionId(context: ForkContext): string {
  return `${context.originRepository.nameWithOwner}:${context.defaultBranch}`;
}

function syncBranchName(context: ForkContext): string {
  const repoSlug = slugForGitRef(context.originRepository.nameWithOwner.replace("/", "-"));
  const branchSlug = slugForGitRef(context.defaultBranch).replace(/\//g, "-");
  return `${SYNC_BRANCH_PREFIX}/${repoSlug}/${branchSlug}`;
}

function syncBranchConfigKey(branch: string, name: string): string {
  return `branch.${branch}.${name}`;
}

function comparisonFields(context: ComparisonContext) {
  return {
    originRemote: context.originRemote.name,
    originRepository: context.originRepository,
    parentRepository: context.parentRepository,
    defaultBranch: context.defaultBranch,
    upstreamRemote: context.upstreamRemote,
    localCommit: context.localCommit,
    originCommit: context.originCommit,
    upstreamCommit: context.upstreamCommit,
    syncSession: context.syncSession,
  };
}

function comparisonWithSession(
  context: ComparisonContext,
  syncSession: GitForkSyncSession | null,
): ComparisonContext {
  return {
    ...context,
    syncSession,
  };
}

function parseNullDelimitedPaths(stdout: string): ReadonlyArray<string> {
  return stdout.split("\0").filter((path) => path.trim().length > 0);
}

function conflictedFilesFromPaths(
  paths: ReadonlyArray<string>,
): ReadonlyArray<GitForkSyncConflictFile> {
  const unique = new Set<string>();
  for (const path of paths) {
    unique.add(path);
  }
  return Array.from(unique)
    .toSorted((left, right) => left.localeCompare(right))
    .map((path) => ({ path }));
}

function remoteStateFields(context: ForkContext) {
  return {
    originRemote: context.originRemote.name,
    originRepository: context.originRepository,
    parentRepository: context.parentRepository,
    defaultBranch: context.defaultBranch,
    upstreamRemote: context.upstreamRemote,
  };
}

function blocked(context: ForkContext, message: string): GitForkSyncStatusResult {
  return {
    _tag: "blocked",
    ...remoteStateFields(context),
    message,
  };
}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const github = yield* GitHubCli.GitHubCli;

  const runGit = Effect.fn("ForkSyncService.runGit")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
    },
  ) {
    return yield* git.execute({
      operation,
      cwd,
      args,
      env: NON_INTERACTIVE_GIT_ENV,
      maxOutputBytes: 256 * 1024,
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  });

  const resolveOptionalCommit = Effect.fn("ForkSyncService.resolveOptionalCommit")(function* (
    cwd: string,
    ref: string,
  ) {
    const result = yield* runGit(
      "ForkSyncService.resolveOptionalCommit",
      cwd,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      return null;
    }
    const commit = result.stdout.trim();
    return commit.length > 0 ? commit : null;
  });

  const isAncestor = Effect.fn("ForkSyncService.isAncestor")(function* (
    cwd: string,
    ancestor: string,
    descendant: string,
  ) {
    const result = yield* runGit(
      "ForkSyncService.isAncestor",
      cwd,
      ["merge-base", "--is-ancestor", ancestor, descendant],
      { allowNonZeroExit: true },
    );
    return result.exitCode === 0;
  });

  const hasWorkingTreeChanges = Effect.fn("ForkSyncService.hasWorkingTreeChanges")(function* (
    cwd: string,
  ) {
    const result = yield* runGit("ForkSyncService.hasWorkingTreeChanges", cwd, [
      "status",
      "--porcelain",
    ]);
    return result.stdout.trim().length > 0;
  });

  const currentBranch = Effect.fn("ForkSyncService.currentBranch")(function* (cwd: string) {
    const result = yield* runGit(
      "ForkSyncService.currentBranch",
      cwd,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      return null;
    }
    const branch = result.stdout.trim();
    return branch.length > 0 && branch !== "HEAD" ? branch : null;
  });

  const unmergedFiles = Effect.fn("ForkSyncService.unmergedFiles")(function* (cwd: string) {
    const result = yield* runGit("ForkSyncService.unmergedFiles", cwd, [
      "diff",
      "--name-only",
      "--diff-filter=U",
      "-z",
    ]);
    return conflictedFilesFromPaths(parseNullDelimitedPaths(result.stdout));
  });

  const hasMergeInProgress = Effect.fn("ForkSyncService.hasMergeInProgress")(function* (
    cwd: string,
  ) {
    const result = yield* runGit(
      "ForkSyncService.hasMergeInProgress",
      cwd,
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      { allowNonZeroExit: true },
    );
    return result.exitCode === 0;
  });

  const readConfigValue = Effect.fn("ForkSyncService.readConfigValue")(function* (
    cwd: string,
    key: string,
  ) {
    const result = yield* runGit("ForkSyncService.readConfigValue", cwd, ["config", "--get", key], {
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  });

  const isOwnedSyncBranch = Effect.fn("ForkSyncService.isOwnedSyncBranch")(function* (
    context: ForkContext,
    branch: string,
  ) {
    const owner = yield* readConfigValue(context.cwd, syncBranchConfigKey(branch, "t3-fork-sync"));
    const session = yield* readConfigValue(
      context.cwd,
      syncBranchConfigKey(branch, "t3-session-id"),
    );
    return owner === "true" && session === syncSessionId(context);
  });

  const markSyncBranchOwned = Effect.fn("ForkSyncService.markSyncBranchOwned")(function* (
    context: ForkContext,
    branch: string,
  ) {
    yield* runGit("ForkSyncService.markSyncBranchOwned.owner", context.cwd, [
      "config",
      syncBranchConfigKey(branch, "t3-fork-sync"),
      "true",
    ]);
    yield* runGit("ForkSyncService.markSyncBranchOwned.session", context.cwd, [
      "config",
      syncBranchConfigKey(branch, "t3-session-id"),
      syncSessionId(context),
    ]);
  });

  const findSyncSession = Effect.fn("ForkSyncService.findSyncSession")(function* (
    context: ForkContext,
  ): Effect.fn.Return<GitForkSyncSession | null, GitCommandError> {
    const branch = syncBranchName(context);
    const refs = yield* git.listRefs({
      cwd: context.cwd,
      refKind: "local",
      includeMatchingRemoteRefs: false,
      limit: 200,
    });
    const ref = refs.refs.find((candidate) => candidate.name === branch) ?? null;
    if (!ref?.worktreePath) {
      return null;
    }
    if (!(yield* isOwnedSyncBranch(context, branch))) {
      return null;
    }
    const conflictedFiles = yield* unmergedFiles(ref.worktreePath);
    return {
      id: syncSessionId(context),
      branch,
      worktreePath: ref.worktreePath,
      conflictedFiles: [...conflictedFiles],
    };
  });

  const ensureSyncWorktree = Effect.fn("ForkSyncService.ensureSyncWorktree")(function* (
    context: ComparisonContext,
  ): Effect.fn.Return<GitForkSyncSession, GitCommandError> {
    const existing = yield* findSyncSession(context);
    if (existing) {
      return existing;
    }

    const branch = syncBranchName(context);
    const originRef = `refs/remotes/${context.originRemote.name}/${context.defaultBranch}`;
    const refs = yield* git.listRefs({
      cwd: context.cwd,
      refKind: "local",
      includeMatchingRemoteRefs: false,
      limit: 200,
    });
    const branchExists = refs.refs.some((candidate) => candidate.name === branch);
    if (branchExists) {
      if (!(yield* isOwnedSyncBranch(context, branch))) {
        return yield* new GitCommandError({
          operation: "ForkSyncService.ensureSyncWorktree",
          command: "git branch",
          cwd: context.cwd,
          detail:
            "A branch at the fork-sync session name already exists but is not owned by this workflow.",
        });
      }
      yield* runGit("ForkSyncService.ensureSyncWorktree.resetBranch", context.cwd, [
        "branch",
        "--force",
        branch,
        originRef,
      ]);
    }

    const worktree = yield* git.createWorktree({
      cwd: context.cwd,
      refName: branchExists ? branch : originRef,
      ...(branchExists ? {} : { newRefName: branch, baseRefName: originRef }),
      path: null,
    });
    yield* markSyncBranchOwned(context, worktree.worktree.refName);
    return {
      id: syncSessionId(context),
      branch: worktree.worktree.refName,
      worktreePath: worktree.worktree.path,
      conflictedFiles: [],
    };
  });

  const cleanupSyncSession = Effect.fn("ForkSyncService.cleanupSyncSession")(function* (
    context: ForkContext,
  ) {
    const session = yield* findSyncSession(context);
    if (session && (yield* isOwnedSyncBranch(context, session.branch))) {
      yield* git
        .removeWorktree({
          cwd: context.cwd,
          path: session.worktreePath,
          force: true,
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    const branch = syncBranchName(context);
    if (yield* isOwnedSyncBranch(context, branch)) {
      yield* runGit(
        "ForkSyncService.cleanupSyncSession.deleteBranch",
        context.cwd,
        ["branch", "-D", branch],
        { allowNonZeroExit: true },
      );
    }
  });

  const classifySyncSession = Effect.fn("ForkSyncService.classifySyncSession")(function* (
    context: ComparisonContext,
    session: GitForkSyncSession,
  ): Effect.fn.Return<GitForkSyncStatusResult, GitCommandError> {
    const conflictedFiles = yield* unmergedFiles(session.worktreePath);
    const nextSession = {
      ...session,
      conflictedFiles: [...conflictedFiles],
    };
    const sessionComparison = comparisonWithSession(context, nextSession);
    if (conflictedFiles.length > 0) {
      return { _tag: "conflicted", ...comparisonFields(sessionComparison) };
    }
    if (yield* hasMergeInProgress(session.worktreePath)) {
      return { _tag: "conflicted", ...comparisonFields(sessionComparison) };
    }

    const sessionCommit = yield* resolveOptionalCommit(session.worktreePath, session.branch);
    const nextComparison = {
      ...sessionComparison,
      localCommit: sessionCommit,
    };
    if (sessionCommit && sessionCommit !== context.originCommit) {
      return { _tag: "push_available", ...comparisonFields(nextComparison) };
    }
    return { _tag: "diverged", ...comparisonFields(nextComparison) };
  });

  const startSyncSession = Effect.fn("ForkSyncService.startSyncSession")(function* (
    context: ComparisonContext,
  ): Effect.fn.Return<GitForkSyncStatusResult, GitCommandError> {
    const session = yield* ensureSyncWorktree(context);
    const originRef = `refs/remotes/${context.originRemote.name}/${context.defaultBranch}`;
    const upstreamRef = `refs/remotes/${context.upstreamRemote}/${context.parentRepository.defaultBranch}`;
    yield* runGit(
      "ForkSyncService.startSyncSession.abortMerge",
      session.worktreePath,
      ["merge", "--abort"],
      { allowNonZeroExit: true },
    );
    yield* runGit("ForkSyncService.startSyncSession.reset", session.worktreePath, [
      "reset",
      "--hard",
      originRef,
    ]);

    const mergeResult = yield* runGit(
      "ForkSyncService.startSyncSession.merge",
      session.worktreePath,
      ["merge", "--no-edit", upstreamRef],
      { allowNonZeroExit: true },
    );
    const conflictedFiles = yield* unmergedFiles(session.worktreePath);
    const nextSession = {
      ...session,
      conflictedFiles: [...conflictedFiles],
    };
    if (conflictedFiles.length > 0) {
      return {
        _tag: "conflicted",
        ...comparisonFields(comparisonWithSession(context, nextSession)),
      };
    }
    if (mergeResult.exitCode !== 0) {
      return blocked(context, "The divergent sync merge failed before producing conflicts.");
    }
    return yield* classifySyncSession(context, nextSession);
  });

  const buildAgentPrompt = Effect.fn("ForkSyncService.buildAgentPrompt")(function* (
    context: ComparisonContext,
    session: GitForkSyncSession,
  ) {
    const conflictedFiles = yield* unmergedFiles(session.worktreePath);
    const fileList =
      conflictedFiles.length === 0
        ? "- No unmerged paths are currently reported; verify the merge state before editing."
        : conflictedFiles.map((file) => `- ${file.path}`).join("\n");
    return [
      "You are resolving a fork-sync merge conflict in an isolated sync worktree.",
      "",
      "Constraints:",
      "- First inspect the conflicted files and propose a concise resolution plan.",
      "- Before editing files, call request_user_input with approve/cancel choices and wait for explicit approval.",
      "- Edit only inside the sync worktree path shown below.",
      "- Do not edit the original checkout.",
      "- After edits, verify there are no unmerged paths before reporting completion.",
      "",
      `Original checkout: ${context.cwd}`,
      `Sync worktree: ${session.worktreePath}`,
      `Sync branch: ${session.branch}`,
      `Fork default branch: ${context.originRepository.nameWithOwner}:${context.defaultBranch}`,
      `Upstream default branch: ${context.parentRepository.nameWithOwner}:${context.parentRepository.defaultBranch}`,
      "",
      "Conflicted files:",
      fileList,
      "",
      "When approved, resolve the conflicts, stage the resolved files, and stop before pushing.",
    ].join("\n");
  });

  const resolveForkContext = Effect.fn("ForkSyncService.resolveForkContext")(function* (
    cwd: string,
  ): Effect.fn.Return<ForkContext | GitForkSyncStatusResult, GitManagerServiceError> {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: "ForkSyncService.status",
            cwd,
            detail: "Failed to detect a VCS repository for fork sync.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return unsupported("non_git_repo", "This directory is not a Git repository.");
    }
    if (handle.kind !== "git") {
      return unsupported("non_git_repo", "Fork sync currently supports Git repositories only.");
    }

    const remoteConfigResult = yield* runGit(
      "ForkSyncService.listRemotes",
      cwd,
      ["config", "--get-regexp", "^remote\\..*\\.url$"],
      { allowNonZeroExit: true },
    );
    const remotes =
      remoteConfigResult.exitCode === 0 ? parseRemoteConfigOutput(remoteConfigResult.stdout) : [];
    const originRemote = remotes.find((remote) => remote.name === "origin") ?? null;
    if (!originRemote) {
      return unsupported("no_origin_remote", 'This repository does not have an "origin" remote.');
    }

    const originRepositoryName = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(originRemote.url);
    if (!originRepositoryName) {
      return unsupported("non_github_origin", "The origin remote is not a GitHub repository.");
    }

    const forkInfo = yield* github
      .getRepositoryForkInfo({
        cwd,
        repository: originRepositoryName,
      })
      .pipe(
        Effect.catchTags({
          GitHubCliAuthenticationError: () =>
            Effect.succeed(
              unsupported(
                "missing_github_auth",
                "GitHub CLI is not authenticated. Run gh auth login and retry.",
              ),
            ),
          GitHubCliUnavailableError: () =>
            Effect.succeed(
              unsupported(
                "fork_metadata_unavailable",
                "GitHub CLI is required to discover fork metadata.",
              ),
            ),
          GitHubCliCommandError: () =>
            Effect.succeed(
              unsupported(
                "fork_metadata_unavailable",
                "GitHub fork metadata could not be loaded for this repository.",
              ),
            ),
          GitHubRepositoryDecodeError: () =>
            Effect.succeed(
              unsupported(
                "fork_metadata_unavailable",
                "GitHub returned repository metadata in an unexpected shape.",
              ),
            ),
          GitHubPullRequestNotFoundError: () =>
            Effect.succeed(
              unsupported(
                "fork_metadata_unavailable",
                "GitHub fork metadata could not be loaded for this repository.",
              ),
            ),
          GitHubPullRequestListDecodeError: () =>
            Effect.succeed(
              unsupported(
                "fork_metadata_unavailable",
                "GitHub fork metadata could not be loaded for this repository.",
              ),
            ),
          GitHubChangeRequestListDecodeError: () =>
            Effect.succeed(
              unsupported(
                "fork_metadata_unavailable",
                "GitHub fork metadata could not be loaded for this repository.",
              ),
            ),
          GitHubPullRequestDecodeError: () =>
            Effect.succeed(
              unsupported(
                "fork_metadata_unavailable",
                "GitHub fork metadata could not be loaded for this repository.",
              ),
            ),
        }),
      );

    if ("_tag" in forkInfo) {
      return forkInfo;
    }
    if (!forkInfo.isFork || !forkInfo.parent) {
      return unsupported("not_a_fork", "The origin GitHub repository is not a fork.");
    }

    const originRepository = repositoryFromGitHub(forkInfo);
    const parentRepository = repositoryFromGitHub(forkInfo.parent);
    const upstreamRemote =
      remotes.find((remote) => remoteMatchesRepository(remote, parentRepository))?.name ?? null;

    return {
      cwd,
      originRemote,
      originRepository,
      parentRepository,
      defaultBranch: originRepository.defaultBranch,
      upstreamRemote,
    };
  });

  const resolveComparison = Effect.fn("ForkSyncService.resolveComparison")(function* (
    context: ForkContext,
    options?: { readonly refreshRemotes?: boolean },
  ): Effect.fn.Return<ComparisonContext | GitForkSyncStatusResult, GitManagerServiceError> {
    if (!context.upstreamRemote) {
      return {
        _tag: "setup_required",
        ...remoteStateFields(context),
      };
    }

    if (options?.refreshRemotes === true) {
      yield* git.fetchRemote({ cwd: context.cwd, remoteName: context.originRemote.name });
      yield* git.fetchRemote({ cwd: context.cwd, remoteName: context.upstreamRemote });
    }

    const localCommit = yield* resolveOptionalCommit(context.cwd, context.defaultBranch);
    const originCommit = yield* resolveOptionalCommit(
      context.cwd,
      `refs/remotes/${context.originRemote.name}/${context.defaultBranch}`,
    );
    const upstreamCommit = yield* resolveOptionalCommit(
      context.cwd,
      `refs/remotes/${context.upstreamRemote}/${context.parentRepository.defaultBranch}`,
    );

    if (!originCommit || !upstreamCommit) {
      return blocked(context, "Could not resolve origin or upstream default branch commits.");
    }

    return {
      ...context,
      localCommit,
      originCommit,
      upstreamCommit,
      syncSession: null,
    };
  });

  const classifyComparison = Effect.fn("ForkSyncService.classifyComparison")(function* (
    context: ComparisonContext,
  ): Effect.fn.Return<GitForkSyncStatusResult, GitCommandError> {
    const fields = comparisonFields(context);
    const originHasUpstream = yield* isAncestor(
      context.cwd,
      context.upstreamCommit,
      context.originCommit,
    );
    const upstreamHasOrigin = yield* isAncestor(
      context.cwd,
      context.originCommit,
      context.upstreamCommit,
    );

    if (context.localCommit && context.localCommit !== context.originCommit) {
      const localHasOrigin = yield* isAncestor(
        context.cwd,
        context.originCommit,
        context.localCommit,
      );
      const originHasLocal = yield* isAncestor(
        context.cwd,
        context.localCommit,
        context.originCommit,
      );
      const localHasUpstream = yield* isAncestor(
        context.cwd,
        context.upstreamCommit,
        context.localCommit,
      );
      const upstreamHasLocal = yield* isAncestor(
        context.cwd,
        context.localCommit,
        context.upstreamCommit,
      );

      if (localHasOrigin && localHasUpstream) {
        return { _tag: "push_available", ...fields };
      }

      if (!originHasUpstream && !upstreamHasOrigin) {
        return { _tag: "diverged", ...fields };
      }

      if (upstreamHasOrigin && (upstreamHasLocal || originHasLocal)) {
        return { _tag: "updates_available", ...fields };
      }

      if (originHasUpstream && originHasLocal) {
        return { _tag: "up_to_date", ...fields };
      }

      return { _tag: "diverged", ...fields };
    }

    if (!originHasUpstream && !upstreamHasOrigin) {
      return { _tag: "diverged", ...fields };
    }

    if (upstreamHasOrigin && context.originCommit !== context.upstreamCommit) {
      return { _tag: "updates_available", ...fields };
    }

    return { _tag: "up_to_date", ...fields };
  });

  const classifyStatus = Effect.fn("ForkSyncService.classifyStatus")(function* (
    comparison: ComparisonContext,
  ): Effect.fn.Return<GitForkSyncStatusResult, GitCommandError> {
    const classified = yield* classifyComparison(comparison);
    if (classified._tag !== "diverged") {
      return classified;
    }
    const session = yield* findSyncSession(comparison);
    if (!session) {
      return classified;
    }
    return yield* classifySyncSession(comparison, session);
  });

  const status = Effect.fn("ForkSyncService.status")(function* (input: GitForkSyncStatusInput) {
    const context = yield* resolveForkContext(input.cwd);
    if ("_tag" in context) return context;
    const comparison = yield* resolveComparison(context, { refreshRemotes: false });
    if ("_tag" in comparison) return comparison;
    return yield* classifyStatus(comparison);
  });

  const setup = Effect.fn("ForkSyncService.setup")(function* (input: GitForkSyncSetupInput) {
    const context = yield* resolveForkContext(input.cwd);
    if ("_tag" in context) return context;
    const existingRemote = context.upstreamRemote;
    if (!existingRemote) {
      yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName ?? DEFAULT_UPSTREAM_REMOTE,
        url: remoteUrlForOriginProtocol(context.originRemote.url, context.parentRepository),
      });
    }
    const nextContext = yield* resolveForkContext(input.cwd);
    if ("_tag" in nextContext) return nextContext;
    const comparison = yield* resolveComparison(nextContext, { refreshRemotes: true });
    if ("_tag" in comparison) return comparison;
    return yield* classifyStatus(comparison);
  });

  const update = Effect.fn("ForkSyncService.update")(function* (input: GitForkSyncUpdateInput) {
    const context = yield* resolveForkContext(input.cwd);
    if ("_tag" in context) return context;
    const comparison = yield* resolveComparison(context, { refreshRemotes: true });
    if ("_tag" in comparison) return comparison;
    const classified = yield* classifyComparison(comparison);
    if (classified._tag === "diverged") {
      return yield* startSyncSession(comparison);
    }
    if (classified._tag !== "updates_available") {
      return classified;
    }

    const branch = yield* currentBranch(input.cwd);
    if (branch === comparison.defaultBranch && (yield* hasWorkingTreeChanges(input.cwd))) {
      return blocked(comparison, "The checked-out default branch has uncommitted changes.");
    }

    const upstreamRef = `refs/remotes/${comparison.upstreamRemote}/${comparison.parentRepository.defaultBranch}`;
    const updateDefaultBranch =
      branch === comparison.defaultBranch
        ? runGit("ForkSyncService.update.merge", input.cwd, ["merge", "--ff-only", upstreamRef])
        : runGit("ForkSyncService.update.branch", input.cwd, [
            "branch",
            "--force",
            comparison.defaultBranch,
            upstreamRef,
          ]);

    const updateResult = yield* Effect.exit(updateDefaultBranch);
    if (updateResult._tag === "Failure") {
      return blocked(
        comparison,
        "The default branch could not be fast-forwarded. It may be checked out in another worktree.",
      );
    }

    const nextContext = yield* resolveForkContext(input.cwd);
    if ("_tag" in nextContext) return nextContext;
    const nextComparison = yield* resolveComparison(nextContext, { refreshRemotes: false });
    if ("_tag" in nextComparison) return nextComparison;
    return yield* classifyStatus(nextComparison);
  });

  const push = Effect.fn("ForkSyncService.push")(function* (input: GitForkSyncPushInput) {
    const context = yield* resolveForkContext(input.cwd);
    if ("_tag" in context) return context;
    const comparison = yield* resolveComparison(context, { refreshRemotes: true });
    if ("_tag" in comparison) return comparison;
    const classified = yield* classifyStatus(comparison);
    if (classified._tag !== "push_available") {
      return classified;
    }
    const syncSession = classified.syncSession;
    if (!comparison.localCommit && !syncSession) {
      return blocked(comparison, "The local default branch does not exist.");
    }

    const sourceRef = syncSession?.branch ?? comparison.defaultBranch;
    yield* runGit("ForkSyncService.push", input.cwd, [
      "push",
      comparison.originRemote.name,
      `${sourceRef}:${comparison.defaultBranch}`,
    ]);
    if (syncSession) {
      yield* cleanupSyncSession(comparison);
    }
    yield* git.fetchRemote({ cwd: input.cwd, remoteName: comparison.originRemote.name });

    const nextContext = yield* resolveForkContext(input.cwd);
    if ("_tag" in nextContext) return nextContext;
    const nextComparison = yield* resolveComparison(nextContext, { refreshRemotes: false });
    if ("_tag" in nextComparison) return nextComparison;
    return yield* classifyStatus(nextComparison);
  });

  const resume = Effect.fn("ForkSyncService.resume")(function* (
    input: GitForkSyncResumeInput,
  ): Effect.fn.Return<GitForkSyncResumeResult, GitManagerServiceError> {
    const context = yield* resolveForkContext(input.cwd);
    if ("_tag" in context) return context;
    const comparison = yield* resolveComparison(context, { refreshRemotes: true });
    if ("_tag" in comparison) return comparison;
    const session = yield* findSyncSession(context);
    if (!session) {
      return blocked(context, "No fork-sync conflict worktree exists to resume.");
    }
    const conflictedFiles = yield* unmergedFiles(session.worktreePath);
    if (conflictedFiles.length > 0) {
      return {
        _tag: "conflicted",
        ...comparisonFields(
          comparisonWithSession(comparison, {
            ...session,
            conflictedFiles: [...conflictedFiles],
          }),
        ),
      };
    }
    if (yield* hasMergeInProgress(session.worktreePath)) {
      const commitResult = yield* runGit(
        "ForkSyncService.resume.commitMerge",
        session.worktreePath,
        ["commit", "--no-edit"],
        { allowNonZeroExit: true },
      );
      if (commitResult.exitCode !== 0) {
        return blocked(context, "The resolved merge could not be committed in the sync worktree.");
      }
    }
    return yield* classifySyncSession(comparison, {
      ...session,
      conflictedFiles: [],
    });
  });

  const abort = Effect.fn("ForkSyncService.abort")(function* (
    input: GitForkSyncAbortInput,
  ): Effect.fn.Return<GitForkSyncAbortResult, GitManagerServiceError> {
    const context = yield* resolveForkContext(input.cwd);
    if ("_tag" in context) return context;
    yield* cleanupSyncSession(context);
    const nextContext = yield* resolveForkContext(input.cwd);
    if ("_tag" in nextContext) return nextContext;
    const comparison = yield* resolveComparison(nextContext, { refreshRemotes: false });
    if ("_tag" in comparison) return comparison;
    return yield* classifyComparison(comparison);
  });

  const agentPrompt = Effect.fn("ForkSyncService.agentPrompt")(function* (
    input: GitForkSyncAgentPromptInput,
  ): Effect.fn.Return<GitForkSyncAgentPromptResult, GitManagerServiceError> {
    const context = yield* resolveForkContext(input.cwd);
    if ("_tag" in context) {
      return { prompt: "Fork sync is not available for this repository.", status: context };
    }
    const comparison = yield* resolveComparison(context, { refreshRemotes: false });
    if ("_tag" in comparison) {
      return { prompt: "Fork sync conflict state is not available.", status: comparison };
    }
    const session = yield* findSyncSession(context);
    if (!session) {
      const status = yield* classifyStatus(comparison);
      return { prompt: "No fork-sync conflict worktree exists.", status };
    }
    const status = yield* classifySyncSession(comparison, session);
    if (status._tag !== "conflicted" || !status.syncSession) {
      return { prompt: "The fork-sync worktree has no unresolved conflicts.", status };
    }
    return {
      prompt: yield* buildAgentPrompt(comparison, status.syncSession),
      status,
    };
  });

  return ForkSyncService.of({
    status,
    setup,
    update,
    push,
    resume,
    abort,
    agentPrompt,
  });
});

export const layer = Layer.effect(ForkSyncService, make);
