import { describe, expect, test } from "bun:test";
import {
  findTodoTransitions,
  isSafeRelativePath,
  parseAutoGitCommand,
  parseAutoGitConfig,
  parseModelPlan,
  parsePorcelainStatus,
  type TodoPhase,
} from "../src/core.ts";

const phases = (...tasks: Array<[string, TodoPhase["tasks"][number]["status"]]>): TodoPhase[] => [
  { name: "Work", tasks: tasks.map(([content, status]) => ({ content, status })) },
];

describe("todo transitions", () => {
  test("finds starts and completions by exact task content", () => {
    expect(findTodoTransitions(
      phases(["first", "pending"], ["second", "in_progress"]),
      phases(["first", "in_progress"], ["second", "completed"]),
    )).toEqual({
      started: [{ content: "first", status: "in_progress" }],
      completed: [{ content: "second", status: "completed" }],
    });
  });

  test("does not report unchanged or repeated completion states", () => {
    const completed = phases(["finished", "completed"]);
    expect(findTodoTransitions(completed, completed)).toEqual({ started: [], completed: [] });
  });

  test("skips ambiguous reused task names", () => {
    expect(findTodoTransitions(
      phases(["same", "pending"]),
      [
        { name: "One", tasks: [{ content: "same", status: "in_progress" }] },
        { name: "Two", tasks: [{ content: "same", status: "completed" }] },
      ],
    )).toEqual({ started: [], completed: [] });
  });
});

describe("Git baseline parsing", () => {
  test("parses staged, unstaged, untracked, and newline-containing paths", () => {
    const parsed = parsePorcelainStatus(" M staged-and-modified\0A  staged\0?? new\nfile\0");
    expect(parsed.unsafe).toBe(false);
    expect(parsed.entries).toEqual([
      { path: "staged-and-modified", indexStatus: " ", worktreeStatus: "M", untracked: false },
      { path: "staged", indexStatus: "A", worktreeStatus: " ", untracked: false },
      { path: "new\nfile", indexStatus: "?", worktreeStatus: "?", untracked: true },
    ]);
  });

  test("marks rename and unresolved conflict baselines unsafe", () => {
    expect(parsePorcelainStatus("R  renamed\0original\0").unsafe).toBe(true);
    expect(parsePorcelainStatus("UU conflicted\0").unsafe).toBe(true);
  });

  test("rejects paths escaping the project working directory", () => {
    expect(isSafeRelativePath("/work/repo", "src/file.ts")).toBe(true);
    expect(isSafeRelativePath("/work/repo", "../secret.txt")).toBe(false);
    expect(isSafeRelativePath("/work/repo", ".")).toBe(false);
  });
});

describe("configuration and model output", () => {
  test("parses model and hook configuration with safe defaults", () => {
    expect(parseAutoGitConfig({ model: " @autogit ", skipPrePostCommitHooks: true })).toEqual({
      model: "@autogit",
      skipPrePostCommitHooks: true,
    });
    expect(parseAutoGitConfig({})).toEqual({ skipPrePostCommitHooks: false });
    expect(() => parseAutoGitConfig({ skipPrePostCommitHooks: "yes" })).toThrow();
    expect(() => parseAutoGitConfig({ unknown: true })).toThrow();
  });

  test("parses slash-command configuration without accepting ambiguous hook values", () => {
    expect(parseAutoGitCommand("model @autogit")).toEqual({ type: "set-model", model: "@autogit" });
    expect(parseAutoGitCommand("model off")).toEqual({ type: "set-model" });
    expect(parseAutoGitCommand("skip-pre-post-commit-hooks on")).toEqual({ type: "set-hooks", enabled: true });
    expect(parseAutoGitCommand("skip-pre-post-commit-hooks maybe").type).toBe("error");
  });

  test("accepts only model-selected candidate paths and a single-line message", () => {
    expect(parseModelPlan(
      JSON.stringify({ files: ["src/a.ts"], message: "fix task output" }),
      ["src/a.ts", "src/b.ts"],
    )).toEqual({ files: ["src/a.ts"], message: "fix task output" });
    expect(() => parseModelPlan(
      JSON.stringify({ files: ["../private"], message: "unsafe" }),
      ["src/a.ts"],
    )).toThrow();
    expect(() => parseModelPlan(
      JSON.stringify({ files: ["src/a.ts"], message: "bad\nsubject" }),
      ["src/a.ts"],
    )).toThrow();
  });
});
