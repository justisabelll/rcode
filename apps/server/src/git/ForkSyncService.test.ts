// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type { GitCommandError } from "@t3tools/contracts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForkSyncService from "./ForkSyncService.ts";

const ORIGIN_REPOSITORY = {
  nameWithOwner: "octocat/t3code",
  url: "https://github.com/octocat/t3code",
  sshUrl: "git@github.com:octocat/t3code.git",
  defaultBranch: "main",
};

const PARENT_REPOSITORY = {
  nameWithOwner: "pingdotgg/t3code",
  url: "https://github.com/pingdotgg/t3code",
  sshUrl: "git@github.com:pingdotgg/t3code.git",
  defaultBranch: "main",
};

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-sync-test-" });

const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(serverConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const registryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(serverConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const testLayer = ForkSyncService.layer.pipe(
  Layer.provideMerge(registryLayer),
  Layer.provideMerge(gitLayer),
  Layer.provide(
    Layer.mock(GitHubCli.GitHubCli)({
      getRepositoryForkInfo: () =>
        Effect.succeed({
          ...ORIGIN_REPOSITORY,
          isFork: true,
          parent: PARENT_REPOSITORY,
        }),
    }),
  ),
);

function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError, GitVcsDriver.GitVcsDriver> {
  return Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return yield* git.execute({
      operation: "ForkSyncService.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
  });
}

const makeTempDir = (prefix: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const initRepository = (cwd: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    yield* fileSystem.writeFileString(NodePath.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });

const appendCommit = (input: {
  readonly cwd: string;
  readonly fileName: string;
  readonly content: string;
  readonly message: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(NodePath.join(input.cwd, input.fileName), input.content);
    yield* runGit(input.cwd, ["add", input.fileName]);
    yield* runGit(input.cwd, ["commit", "-m", input.message]);
  });

const createBareRemote = (prefix: string) =>
  Effect.gen(function* () {
    const remoteDir = yield* makeTempDir(prefix);
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });

const configureVisibleRemote = (input: {
  readonly cwd: string;
  readonly remoteName: string;
  readonly visibleUrl: string;
  readonly localUrl: string;
}) =>
  Effect.gen(function* () {
    yield* runGit(input.cwd, ["remote", "add", input.remoteName, input.visibleUrl]);
    yield* runGit(input.cwd, ["config", `url.${input.localUrl}.insteadOf`, input.visibleUrl]);
  });

it.effect("returns setup_required without adding upstream during status", () =>
  Effect.gen(function* () {
    const repoDir = yield* makeTempDir("t3-fork-sync-repo-");
    const originDir = yield* createBareRemote("t3-fork-sync-origin-");
    const parentDir = yield* createBareRemote("t3-fork-sync-parent-");
    yield* initRepository(repoDir);
    yield* configureVisibleRemote({
      cwd: repoDir,
      remoteName: "origin",
      visibleUrl: ORIGIN_REPOSITORY.url,
      localUrl: originDir,
    });
    yield* runGit(repoDir, ["config", `url.${parentDir}.insteadOf`, PARENT_REPOSITORY.url]);
    yield* runGit(repoDir, ["push", "-u", "origin", "main"]);

    const service = yield* ForkSyncService.ForkSyncService;
    const status = yield* service.status({ cwd: repoDir });

    assert.equal(status._tag, "setup_required");
    const remotesAfterStatus = (yield* runGit(repoDir, ["remote"])).stdout.trim().split("\n");
    assert.deepStrictEqual(remotesAfterStatus, ["origin"]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("returns no_origin_remote for a git repository without remotes", () =>
  Effect.gen(function* () {
    const repoDir = yield* makeTempDir("t3-fork-sync-repo-");
    yield* initRepository(repoDir);

    const service = yield* ForkSyncService.ForkSyncService;
    const status = yield* service.status({ cwd: repoDir });

    assert.equal(status._tag, "unsupported");
    if (status._tag === "unsupported") {
      assert.equal(status.reason, "no_origin_remote");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("adds upstream only through setup", () =>
  Effect.gen(function* () {
    const repoDir = yield* makeTempDir("t3-fork-sync-repo-");
    const originDir = yield* createBareRemote("t3-fork-sync-origin-");
    const parentDir = yield* createBareRemote("t3-fork-sync-parent-");
    yield* initRepository(repoDir);
    yield* configureVisibleRemote({
      cwd: repoDir,
      remoteName: "origin",
      visibleUrl: ORIGIN_REPOSITORY.url,
      localUrl: originDir,
    });
    yield* runGit(repoDir, ["config", `url.${parentDir}.insteadOf`, PARENT_REPOSITORY.url]);
    yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
    yield* runGit(repoDir, ["remote", "add", "parent-seed", parentDir]);
    yield* runGit(repoDir, ["push", "parent-seed", "main"]);
    yield* runGit(repoDir, ["remote", "remove", "parent-seed"]);

    const service = yield* ForkSyncService.ForkSyncService;
    const result = yield* service.setup({ cwd: repoDir });

    assert.equal(result._tag, "up_to_date");
    const upstreamUrl = (yield* runGit(repoDir, [
      "config",
      "--get",
      "remote.upstream.url",
    ])).stdout.trim();
    assert.equal(upstreamUrl, PARENT_REPOSITORY.url);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("merges divergent origin and upstream in an isolated sync worktree", () =>
  Effect.gen(function* () {
    const repoDir = yield* makeTempDir("t3-fork-sync-repo-");
    const originWorkDir = yield* makeTempDir("t3-fork-sync-origin-work-");
    const parentWorkDir = yield* makeTempDir("t3-fork-sync-parent-work-");
    const originDir = yield* createBareRemote("t3-fork-sync-origin-");
    const parentDir = yield* createBareRemote("t3-fork-sync-parent-");
    yield* initRepository(repoDir);
    yield* configureVisibleRemote({
      cwd: repoDir,
      remoteName: "origin",
      visibleUrl: ORIGIN_REPOSITORY.url,
      localUrl: originDir,
    });
    yield* runGit(repoDir, ["config", `url.${parentDir}.insteadOf`, PARENT_REPOSITORY.url]);
    yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
    yield* runGit(repoDir, ["remote", "add", "parent-seed", parentDir]);
    yield* runGit(repoDir, ["push", "parent-seed", "main"]);
    yield* runGit(repoDir, ["remote", "remove", "parent-seed"]);

    const service = yield* ForkSyncService.ForkSyncService;
    yield* service.setup({ cwd: repoDir });

    yield* runGit(repoDir, ["clone", originDir, originWorkDir]);
    yield* runGit(originWorkDir, ["config", "user.email", "test@example.com"]);
    yield* runGit(originWorkDir, ["config", "user.name", "Test User"]);
    yield* appendCommit({
      cwd: originWorkDir,
      fileName: "ORIGIN.md",
      content: "origin\n",
      message: "Origin update",
    });
    yield* runGit(originWorkDir, ["push", "origin", "main"]);

    yield* runGit(repoDir, ["clone", parentDir, parentWorkDir]);
    yield* runGit(parentWorkDir, ["config", "user.email", "test@example.com"]);
    yield* runGit(parentWorkDir, ["config", "user.name", "Test User"]);
    yield* appendCommit({
      cwd: parentWorkDir,
      fileName: "UPSTREAM.md",
      content: "upstream\n",
      message: "Upstream update",
    });
    yield* runGit(parentWorkDir, ["push", "origin", "main"]);

    const localMainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
    const result = yield* service.update({ cwd: repoDir });

    assert.equal(result._tag, "push_available");
    if (result._tag !== "push_available") return;
    assert.notEqual(result.syncSession, null);
    assert.equal(result.syncSession?.conflictedFiles.length, 0);
    assert.equal((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim(), localMainBefore);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("returns push_available after a fast-forward update", () =>
  Effect.gen(function* () {
    const repoDir = yield* makeTempDir("t3-fork-sync-repo-");
    const parentWorkDir = yield* makeTempDir("t3-fork-sync-parent-work-");
    const originDir = yield* createBareRemote("t3-fork-sync-origin-");
    const parentDir = yield* createBareRemote("t3-fork-sync-parent-");
    yield* initRepository(repoDir);
    yield* configureVisibleRemote({
      cwd: repoDir,
      remoteName: "origin",
      visibleUrl: ORIGIN_REPOSITORY.url,
      localUrl: originDir,
    });
    yield* runGit(repoDir, ["config", `url.${parentDir}.insteadOf`, PARENT_REPOSITORY.url]);
    yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
    yield* runGit(repoDir, ["remote", "add", "parent-seed", parentDir]);
    yield* runGit(repoDir, ["push", "parent-seed", "main"]);
    yield* runGit(repoDir, ["remote", "remove", "parent-seed"]);

    const service = yield* ForkSyncService.ForkSyncService;
    yield* service.setup({ cwd: repoDir });

    yield* runGit(repoDir, ["clone", parentDir, parentWorkDir]);
    yield* runGit(parentWorkDir, ["config", "user.email", "test@example.com"]);
    yield* runGit(parentWorkDir, ["config", "user.name", "Test User"]);
    yield* appendCommit({
      cwd: parentWorkDir,
      fileName: "UPSTREAM.md",
      content: "upstream\n",
      message: "Upstream update",
    });
    yield* runGit(parentWorkDir, ["push", "origin", "main"]);

    const result = yield* service.update({ cwd: repoDir });

    assert.equal(result._tag, "push_available");
    const originCommit = (yield* runGit(repoDir, [
      "rev-parse",
      "refs/remotes/origin/main",
    ])).stdout.trim();
    const localCommit = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
    assert.notEqual(originCommit, localCommit);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not force-move a local default branch with divergent commits", () =>
  Effect.gen(function* () {
    const repoDir = yield* makeTempDir("t3-fork-sync-repo-");
    const parentWorkDir = yield* makeTempDir("t3-fork-sync-parent-work-");
    const originDir = yield* createBareRemote("t3-fork-sync-origin-");
    const parentDir = yield* createBareRemote("t3-fork-sync-parent-");
    yield* initRepository(repoDir);
    yield* configureVisibleRemote({
      cwd: repoDir,
      remoteName: "origin",
      visibleUrl: ORIGIN_REPOSITORY.url,
      localUrl: originDir,
    });
    yield* runGit(repoDir, ["config", `url.${parentDir}.insteadOf`, PARENT_REPOSITORY.url]);
    yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
    yield* runGit(repoDir, ["remote", "add", "parent-seed", parentDir]);
    yield* runGit(repoDir, ["push", "parent-seed", "main"]);
    yield* runGit(repoDir, ["remote", "remove", "parent-seed"]);

    const service = yield* ForkSyncService.ForkSyncService;
    yield* service.setup({ cwd: repoDir });
    yield* appendCommit({
      cwd: repoDir,
      fileName: "LOCAL.md",
      content: "local\n",
      message: "Local default branch commit",
    });
    const localMainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
    yield* runGit(repoDir, ["checkout", "-b", "feature/work"]);

    yield* runGit(repoDir, ["clone", parentDir, parentWorkDir]);
    yield* runGit(parentWorkDir, ["config", "user.email", "test@example.com"]);
    yield* runGit(parentWorkDir, ["config", "user.name", "Test User"]);
    yield* appendCommit({
      cwd: parentWorkDir,
      fileName: "UPSTREAM.md",
      content: "upstream\n",
      message: "Upstream update",
    });
    yield* runGit(parentWorkDir, ["push", "origin", "main"]);

    const result = yield* service.update({ cwd: repoDir });

    assert.equal(result._tag, "push_available");
    if (result._tag !== "push_available") return;
    assert.notEqual(result.syncSession, null);
    assert.equal(result.syncSession?.conflictedFiles.length, 0);
    assert.equal((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim(), localMainBefore);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports conflicts, generates a scoped agent prompt, resumes, and aborts", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const repoDir = yield* makeTempDir("t3-fork-sync-repo-");
    const originWorkDir = yield* makeTempDir("t3-fork-sync-origin-work-");
    const parentWorkDir = yield* makeTempDir("t3-fork-sync-parent-work-");
    const originDir = yield* createBareRemote("t3-fork-sync-origin-");
    const parentDir = yield* createBareRemote("t3-fork-sync-parent-");
    yield* initRepository(repoDir);
    yield* configureVisibleRemote({
      cwd: repoDir,
      remoteName: "origin",
      visibleUrl: ORIGIN_REPOSITORY.url,
      localUrl: originDir,
    });
    yield* runGit(repoDir, ["config", `url.${parentDir}.insteadOf`, PARENT_REPOSITORY.url]);
    yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
    yield* runGit(repoDir, ["remote", "add", "parent-seed", parentDir]);
    yield* runGit(repoDir, ["push", "parent-seed", "main"]);
    yield* runGit(repoDir, ["remote", "remove", "parent-seed"]);

    const service = yield* ForkSyncService.ForkSyncService;
    yield* service.setup({ cwd: repoDir });

    yield* runGit(repoDir, ["clone", originDir, originWorkDir]);
    yield* runGit(originWorkDir, ["config", "user.email", "test@example.com"]);
    yield* runGit(originWorkDir, ["config", "user.name", "Test User"]);
    yield* appendCommit({
      cwd: originWorkDir,
      fileName: "README.md",
      content: "origin change\n",
      message: "Origin README update",
    });
    yield* runGit(originWorkDir, ["push", "origin", "main"]);

    yield* runGit(repoDir, ["clone", parentDir, parentWorkDir]);
    yield* runGit(parentWorkDir, ["config", "user.email", "test@example.com"]);
    yield* runGit(parentWorkDir, ["config", "user.name", "Test User"]);
    yield* appendCommit({
      cwd: parentWorkDir,
      fileName: "README.md",
      content: "upstream change\n",
      message: "Upstream README update",
    });
    yield* runGit(parentWorkDir, ["push", "origin", "main"]);

    const conflicted = yield* service.update({ cwd: repoDir });

    assert.equal(conflicted._tag, "conflicted");
    if (conflicted._tag !== "conflicted") return;
    assert.equal(conflicted.syncSession?.conflictedFiles[0]?.path, "README.md");
    const syncWorktreePath = conflicted.syncSession?.worktreePath;
    assert.ok(syncWorktreePath);
    assert.equal((yield* fileSystem.exists(syncWorktreePath)).valueOf(), true);

    const prompt = yield* service.agentPrompt({ cwd: repoDir });
    assert.equal(prompt.status._tag, "conflicted");
    assert.ok(prompt.prompt.includes(syncWorktreePath));
    assert.ok(prompt.prompt.includes("README.md"));
    assert.ok(prompt.prompt.includes("call request_user_input"));

    const unresolvedResume = yield* service.resume({ cwd: repoDir });
    assert.equal(unresolvedResume._tag, "conflicted");

    yield* fileSystem.writeFileString(
      NodePath.join(syncWorktreePath, "README.md"),
      "origin change\nupstream change\n",
    );
    yield* runGit(syncWorktreePath, ["add", "README.md"]);

    const resolvedStatus = yield* service.status({ cwd: repoDir });
    assert.equal(resolvedStatus._tag, "conflicted");

    const resumed = yield* service.resume({ cwd: repoDir });
    assert.equal(resumed._tag, "push_available");
    if (resumed._tag !== "push_available") return;
    assert.equal(resumed.syncSession?.conflictedFiles.length, 0);

    const aborted = yield* service.abort({ cwd: repoDir });
    assert.equal(aborted._tag, "diverged");
    assert.equal((yield* fileSystem.exists(syncWorktreePath)).valueOf(), false);
    const branchExists = yield* runGit(
      repoDir,
      ["rev-parse", "--verify", "--quiet", "refs/heads/t3/fork-sync/octocat-t3code/main"],
      true,
    );
    assert.notEqual(branchExists.exitCode, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses to overwrite an unowned sync branch name", () =>
  Effect.gen(function* () {
    const repoDir = yield* makeTempDir("t3-fork-sync-repo-");
    const originWorkDir = yield* makeTempDir("t3-fork-sync-origin-work-");
    const parentWorkDir = yield* makeTempDir("t3-fork-sync-parent-work-");
    const originDir = yield* createBareRemote("t3-fork-sync-origin-");
    const parentDir = yield* createBareRemote("t3-fork-sync-parent-");
    yield* initRepository(repoDir);
    yield* configureVisibleRemote({
      cwd: repoDir,
      remoteName: "origin",
      visibleUrl: ORIGIN_REPOSITORY.url,
      localUrl: originDir,
    });
    yield* runGit(repoDir, ["config", `url.${parentDir}.insteadOf`, PARENT_REPOSITORY.url]);
    yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
    yield* runGit(repoDir, ["remote", "add", "parent-seed", parentDir]);
    yield* runGit(repoDir, ["push", "parent-seed", "main"]);
    yield* runGit(repoDir, ["remote", "remove", "parent-seed"]);

    const service = yield* ForkSyncService.ForkSyncService;
    yield* service.setup({ cwd: repoDir });
    yield* runGit(repoDir, ["branch", "t3/fork-sync/octocat-t3code/main"]);

    yield* runGit(repoDir, ["clone", originDir, originWorkDir]);
    yield* runGit(originWorkDir, ["config", "user.email", "test@example.com"]);
    yield* runGit(originWorkDir, ["config", "user.name", "Test User"]);
    yield* appendCommit({
      cwd: originWorkDir,
      fileName: "ORIGIN.md",
      content: "origin\n",
      message: "Origin update",
    });
    yield* runGit(originWorkDir, ["push", "origin", "main"]);

    yield* runGit(repoDir, ["clone", parentDir, parentWorkDir]);
    yield* runGit(parentWorkDir, ["config", "user.email", "test@example.com"]);
    yield* runGit(parentWorkDir, ["config", "user.name", "Test User"]);
    yield* appendCommit({
      cwd: parentWorkDir,
      fileName: "UPSTREAM.md",
      content: "upstream\n",
      message: "Upstream update",
    });
    yield* runGit(parentWorkDir, ["push", "origin", "main"]);

    const result = yield* Effect.exit(service.update({ cwd: repoDir }));

    assert.equal(result._tag, "Failure");
    const branchCommit = (yield* runGit(repoDir, [
      "rev-parse",
      "t3/fork-sync/octocat-t3code/main",
    ])).stdout.trim();
    const mainCommit = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
    assert.equal(branchCommit, mainCommit);
  }).pipe(Effect.provide(testLayer)),
);
