import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type RpcFrame = {
  type?: string;
  id?: string;
  success?: boolean;
  error?: string;
  command?: string;
  status?: string;
  data?: Record<string, unknown>;
};

class RpcClient {
  readonly process: ChildProcessWithoutNullStreams;
  private frames: RpcFrame[] = [];
  private waiters: Array<{
    predicate: (frame: RpcFrame) => boolean;
    resolve: (frame: RpcFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private pending = "";
  private sequence = 0;
  private stderrText = "";

  constructor(binary: string, model: string, cwd: string) {
    this.process = spawn(binary, ["--mode", "rpc", "--no-ui", "--model", model], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.readChunk(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderrText = `${this.stderrText}${chunk.toString("utf8")}`.slice(-8_192);
    });
    this.process.on("error", error => this.failWaiters(error));
    this.process.on("exit", code => {
      this.failWaiters(new Error(`OMP exited with code ${code}: ${this.stderrText}`));
    });
  }

  async ready(): Promise<void> {
    await this.waitFor(frame => frame.type === "ready", 30_000);
  }

  async request(command: Record<string, unknown>, timeout = 60_000): Promise<RpcFrame> {
    const id = `autogit-e2e-${++this.sequence}`;
    const response = this.waitFor(frame => frame.type === "response" && frame.id === id, timeout);
    this.send({ ...command, id });
    const frame = await response;
    if (!frame.success) throw new Error(`RPC ${String(command.type)} failed: ${frame.error ?? "unknown error"}`);
    return frame;
  }

  async prompt(message: string): Promise<void> {
    const id = `autogit-e2e-${++this.sequence}`;
    const responsePromise = this.waitFor(frame => frame.type === "response" && frame.id === id, 60_000);
    this.send({ type: "prompt", id, message });
    const response = await responsePromise;
    if (!response.success) throw new Error(`Prompt admission failed: ${response.error ?? "unknown error"}`);
    if (response.data?.agentInvoked === false) return;

    const result = await this.waitFor(frame => frame.type === "prompt_result" && frame.id === id, 300_000);
    assert.equal(result.status, "completed", `OMP prompt ended as ${result.status}: ${result.error ?? ""}`);
  }

  async close(): Promise<void> {
    if (this.process.pid === undefined || this.process.exitCode !== null || this.process.signalCode !== null) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      this.process.kill("SIGTERM");
      reject(new Error(`OMP did not exit after RPC stdin closed: ${this.stderrText}`));
    }, 15_000);
    this.process.once("exit", finish);
    if (this.process.exitCode !== null || this.process.signalCode !== null) finish();
    this.process.stdin.end();
    await promise;
  }

  private send(frame: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private readChunk(chunk: Buffer): void {
    this.pending += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as RpcFrame;
      if (!["ready", "response", "prompt_result"].includes(frame.type ?? "")) continue;
      const waiterIndex = this.waiters.findIndex(waiter => waiter.predicate(frame));
      if (waiterIndex < 0) {
        this.frames.push(frame);
        continue;
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  private waitFor(predicate: (frame: RpcFrame) => boolean, timeoutMs: number): Promise<RpcFrame> {
    const frameIndex = this.frames.findIndex(predicate);
    if (frameIndex >= 0) return Promise.resolve(this.frames.splice(frameIndex, 1)[0]);
    const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
    const timer = setTimeout(() => {
      this.waiters = this.waiters.filter(waiter => waiter.timer !== timer);
      reject(new Error(`Timed out waiting for OMP RPC frame: ${this.stderrText}`));
    }, timeoutMs);
    this.waiters.push({ predicate, resolve, reject, timer });
    return promise;
  }

  private failWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

async function run(binary: string, args: string[], cwd: string): Promise<string> {
  const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  const closeResult = await once(child, "close");
  const code = closeResult[0] as number | null;
  if (code !== 0) throw new Error(`${binary} ${args.join(" ")} failed: ${Buffer.concat(stderr).toString("utf8")}`);
  return Buffer.concat(stdout).toString("utf8");
}



function taskPrompt(task: string, writes: Array<[string, string]>, unrelatedChange?: [string, string]): string {
  const instructions = writes.map(([path, content]) => `Use the write tool to replace ${path} with exactly this text: ${JSON.stringify(content)}.`);
  if (unrelatedChange) {
    const [path, content] = unrelatedChange;
    instructions.push(`Use the write tool to change ${path} to exactly ${JSON.stringify(content)} as unrelated work. The todo task explicitly excludes that file; do not commit it.`);
  }
  return [
    `Call todo with {"op":"init","items":[${JSON.stringify(task)}]} as your first tool call. Wait for success.`,
    ...instructions,
    `After all writes succeed, call todo with {"op":"done","task":${JSON.stringify(task)}}.`,
    "Do not call Bash, shell, or Git. Do not use any tools except todo and write. Do not change any other file.",
  ].join("\n");
}

function repeatedSnapshotTaskPrompt(task: string, writes: Array<[string, string]>): string {
  const instructions = writes.map(([path, content]) => `Use the write tool to replace ${path} with exactly this text: ${JSON.stringify(content)}.`);
  return [
    `Call todo with {"op":"init","items":[${JSON.stringify(task)}]} as your first tool call. Wait for success.`,
    `Call todo with {"op":"start","task":${JSON.stringify(task)}}. Wait for success.`,
    `Call todo with {"op":"block","task":${JSON.stringify(task)},"reason":"temporary regression"}. Wait for success.`,
    `Call todo with {"op":"start","task":${JSON.stringify(task)}}. Wait for success.`,
    ...instructions,
    `After all writes succeed, call todo with {"op":"done","task":${JSON.stringify(task)}}.`,
    "Do not call Bash, shell, or Git. Do not use any tools except todo and write. Do not change any other file.",
  ].join("\n");
}

async function assertLatestCommit(repo: string, message: string, expectedFiles: string[]): Promise<void> {
  const subject = (await run("git", ["log", "-1", "--format=%s"], repo)).trim();
  assert.equal(subject, message);
  const files = (await run("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], repo))
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(files, [...expectedFiles].sort());
}

async function main(): Promise<void> {
  const hostModel = process.env.OMP_TEST_MODEL;
  if (!hostModel) throw new Error("Set OMP_TEST_MODEL to an authenticated model selector before running test:e2e.");
  const reviewModel = process.env.AUTOGIT_TEST_REVIEW_MODEL ?? hostModel;
  const binary = process.env.OMP_BIN ?? "omp";
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const fixture = resolve(packageRoot, "fixture");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-autocommit-e2e-"));
  const repo = join(temporaryRoot, "repo");
  const workdir = join(repo, "src");
  await mkdir(repo);

  try {
    await cp(fixture, repo, { recursive: true });
    await writeFile(
      join(repo, ".omp", "config.yml"),
      `extensions:\n  - ${JSON.stringify(packageRoot)}\n`,
      "utf8",
    );
    await run("git", ["init", "--quiet"], repo);
    await run("git", ["config", "user.name", "AutoGit E2E"], repo);
    await run("git", ["config", "user.email", "autogit-e2e@example.invalid"], repo);
    await run("git", ["config", "commit.gpgsign", "false"], repo);
    await run("git", ["add", "--", "src"], repo);
    await run("git", ["commit", "--quiet", "-m", "fixture baseline"], repo);

    const hooks = join(repo, "custom-hooks");
    await mkdir(hooks, { recursive: true });
    await run("git", ["config", "core.hooksPath", "custom-hooks"], repo);
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nprintf 'ran\\n' > pre-hook-ran\n", { mode: 0o755 });
    await writeFile(join(hooks, "prepare-commit-msg"), "#!/bin/sh\nprintf '%s\\n' \"$0\" >> prepare-hook-ran\n", { mode: 0o755 });
    await writeFile(
      join(hooks, "commit-msg"),
      "#!/bin/sh\nprintf '%s\\n' \"$0\" >> commit-msg-ran\nif grep -q 'Trigger hook failure' \"$1\"; then exit 1; fi\n",
      { mode: 0o755 },
    );
    await writeFile(join(hooks, "post-commit"), "#!/bin/sh\nprintf 'ran\\n' > post-hook-ran\n", { mode: 0o755 });
    await writeFile(join(repo, "src", "preexisting.txt"), "dirty before task baseline\n", "utf8");
    await writeFile(join(repo, "src", "preexisting-staged.txt"), "staged before task baseline\n", "utf8");
    await run("git", ["add", "--", "src/preexisting-staged.txt"], repo);
    const rpc = new RpcClient(binary, hostModel, workdir);
    try {
      await rpc.ready();
      const state = await rpc.request({ type: "get_state" });
      const systemPrompt = JSON.stringify(state.data?.systemPrompt ?? "");
      assert.match(systemPrompt, /MUST NOT run or invoke `git commit`/);
      await rpc.prompt("/autogit model off");
      await rpc.prompt("/autogit skip-pre-post-commit-hooks on");
      const config = JSON.parse(await readFile(join(workdir, ".omp", "autogit.json"), "utf8")) as Record<string, unknown>;
      assert.equal(config.skipPrePostCommitHooks, true);
      assert.equal(config.model, undefined);

      const deterministicTask = "Update src/output.txt for AutoGit E2E deterministic commit";
      await rpc.prompt(repeatedSnapshotTaskPrompt(deterministicTask, [["output.txt", "deterministic task output\n"]]));
      await assertLatestCommit(repo, `Complete task: ${deterministicTask}`, ["src/output.txt"]);
      assert.equal(await readFile(join(repo, "pre-hook-ran")).then(() => true, () => false), false);
      assert.equal(await readFile(join(repo, "post-hook-ran")).then(() => true, () => false), false);
      assert.equal(await readFile(join(repo, "prepare-hook-ran"), "utf8"), `${join(hooks, "prepare-commit-msg")}\n`);
      assert.equal(await readFile(join(repo, "commit-msg-ran"), "utf8"), `${join(hooks, "commit-msg")}\n`);
      assert.deepEqual(
        (await run("git", ["diff", "--cached", "--name-only"], repo)).trim().split("\n"),
        ["src/preexisting-staged.txt"],
      );

      const failedCommitTask = "Trigger hook failure and verify untracked rollback";
      await rpc.prompt(taskPrompt(failedCommitTask, [["hook-failure.txt", "must remain unstaged\n"]]));
      assert.equal((await run("git", ["log", "-1", "--format=%s"], repo)).trim(), `Complete task: ${deterministicTask}`);
      assert.match(
        await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], repo),
        /^\?\? src\/hook-failure\.txt$/m,
      );
      assert.deepEqual(
        (await run("git", ["diff", "--cached", "--name-only"], repo)).trim().split("\n"),
        ["src/preexisting-staged.txt"],
      );
      const reviewTask = "Update src/review-owned.txt only; src/decoy.txt is unrelated and must not be committed";
      await rpc.prompt(`/autogit model ${reviewModel}`);
      const configured = JSON.parse(await readFile(join(workdir, ".omp", "autogit.json"), "utf8")) as Record<string, unknown>;
      assert.equal(configured.model, reviewModel);
      await rpc.prompt(taskPrompt(
        reviewTask,
        [["review-owned.txt", "selected task-owned change\n"]],
        ["decoy.txt", "unrelated change\n"],
      ));
      const modelCommit = (await run("git", ["log", "-1", "--format=%s"], repo)).trim();
      await assertLatestCommit(repo, modelCommit, ["src/review-owned.txt"]);
      assert.match(await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], repo), /src\/decoy\.txt/);
      assert.match(await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], repo), /src\/preexisting\.txt/);
      assert.equal(await readFile(join(repo, "pre-hook-ran")).then(() => true, () => false), false);
      assert.equal(await readFile(join(repo, "post-hook-ran")).then(() => true, () => false), false);
      const unavailableReviewTask = "Update src/output.txt with unavailable review model";
      await rpc.prompt("/autogit model __autogit_missing_model__");
      await rpc.prompt(taskPrompt(
        unavailableReviewTask,
        [["output.txt", "model review must fail closed\n"]],
      ));
      assert.equal((await run("git", ["log", "-1", "--format=%s"], repo)).trim(), modelCommit);
      assert.match(await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], repo), /src\/output\.txt/);
      console.log("AutoGit OMP E2E passed: nested-repo paths, repeated todo snapshots, staged-path preservation, commit rollback, selective hook bypass, deterministic and configured-model commits, fail-closed review.");
    } finally {
      await rpc.close();
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
