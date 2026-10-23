import { isAbsolute, relative, resolve, sep } from "node:path";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoTask {
  content: string;
  status: TodoStatus;
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

export interface TodoTransition {
  content: string;
  status: TodoStatus;
}

export interface GitStatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
}

export interface ParsedGitStatus {
  entries: GitStatusEntry[];
  unsafe: boolean;
}

export interface AutoGitConfig {
  model?: string;
  skipPrePostCommitHooks: boolean;
}

export type AutoGitCommand =
  | { type: "show" }
  | { type: "help" }
  | { type: "set-model"; model?: string }
  | { type: "set-hooks"; enabled: boolean };

const TODO_STATUSES = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "abandoned",
  "blocked",
]);

export function parseTodoPhases(value: unknown): TodoPhase[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases: TodoPhase[] = [];
  for (const rawPhase of value) {
    if (!isRecord(rawPhase) || typeof rawPhase.name !== "string" || !Array.isArray(rawPhase.tasks)) {
      return undefined;
    }
    const tasks: TodoTask[] = [];
    for (const rawTask of rawPhase.tasks) {
      if (
        !isRecord(rawTask) ||
        typeof rawTask.content !== "string" ||
        typeof rawTask.status !== "string" ||
        !TODO_STATUSES.has(rawTask.status as TodoStatus)
      ) {
        return undefined;
      }
      tasks.push({ content: rawTask.content, status: rawTask.status as TodoStatus });
    }
    phases.push({ name: rawPhase.name, tasks });
  }
  return phases;
}

export function findTodoTransitions(
  previous: TodoPhase[],
  next: TodoPhase[],
): { started: TodoTransition[]; completed: TodoTransition[] } {
  const before = indexUniqueTasks(previous);
  const after = indexUniqueTasks(next);
  const ambiguous = new Set([
    ...duplicateTaskNames(previous),
    ...duplicateTaskNames(next),
  ]);
  const started: TodoTransition[] = [];
  const completed: TodoTransition[] = [];

  for (const task of after.values()) {
    if (ambiguous.has(task.content)) continue;
    const prior = before.get(task.content);
    if (task.status === "in_progress" && prior?.status !== "in_progress") {
      started.push(task);
    }
    if (task.status === "completed" && prior && prior.status !== "completed") {
      completed.push(task);
    }
  }
  return { started, completed };
}

export function indexUniqueTasks(phases: TodoPhase[]): Map<string, TodoTransition> {
  const counts = new Map<string, number>();
  const tasks = new Map<string, TodoTransition>();
  for (const phase of phases) {
    for (const task of phase.tasks) {
      counts.set(task.content, (counts.get(task.content) ?? 0) + 1);
      tasks.set(task.content, { content: task.content, status: task.status });
    }
  }
  for (const [content, count] of counts) {
    if (count > 1) tasks.delete(content);
  }
  return tasks;
}

export function duplicateTaskNames(phases: TodoPhase[]): Set<string> {
  const counts = new Map<string, number>();
  for (const phase of phases) {
    for (const task of phase.tasks) {
      counts.set(task.content, (counts.get(task.content) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([content]) => content));
}

export function parsePorcelainStatus(raw: string): ParsedGitStatus {
  const fields = raw.split("\0");
  const entries: GitStatusEntry[] = [];
  const seen = new Set<string>();
  let unsafe = false;

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    if (field.startsWith("?? ")) {
      const path = field.slice(3);
      if (!path || seen.has(path)) {
        unsafe = true;
        continue;
      }
      seen.add(path);
      entries.push({ path, indexStatus: "?", worktreeStatus: "?", untracked: true });
      continue;
    }
    if (field.length < 4 || field[2] !== " ") {
      unsafe = true;
      continue;
    }

    const indexStatus = field[0];
    const worktreeStatus = field[1];
    const path = field.slice(3);
    if (!path || seen.has(path)) unsafe = true;
    if (indexStatus === "U" || worktreeStatus === "U") unsafe = true;
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      unsafe = true;
      index++;
      continue;
    }
    if (!path || seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, indexStatus, worktreeStatus, untracked: false });
  }
  return { entries, unsafe };
}

export function isSafeRelativePath(cwd: string, filePath: string): boolean {
  const root = resolve(cwd);
  const target = resolve(root, filePath);
  const fromRoot = relative(root, target);
  return Boolean(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

export function parseAutoGitConfig(value: unknown): AutoGitConfig {
  if (!isRecord(value)) throw new Error("Configuration root must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "model" && key !== "skipPrePostCommitHooks") {
      throw new Error(`Unknown configuration key: ${key}`);
    }
  }

  let model: string | undefined;
  if (value.model !== undefined) {
    if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 512 || /[\0\r\n]/.test(value.model)) {
      throw new Error("model must be a non-empty, single-line selector of at most 512 characters");
    }
    model = value.model.trim();
  }

  if (value.skipPrePostCommitHooks !== undefined && typeof value.skipPrePostCommitHooks !== "boolean") {
    throw new Error("skipPrePostCommitHooks must be a boolean");
  }
  return {
    ...(model === undefined ? {} : { model }),
    skipPrePostCommitHooks: value.skipPrePostCommitHooks === true,
  };
}

export function parseAutoGitCommand(args: string): AutoGitCommand | { type: "error"; message: string } {
  const trimmed = args.trim();
  if (!trimmed || trimmed.toLowerCase() === "show") return { type: "show" };
  if (trimmed.toLowerCase() === "help") return { type: "help" };

  const model = /^model(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (model) {
    const selector = model[1]?.trim();
    if (!selector) return { type: "show" };
    if (selector.toLowerCase() === "off") return { type: "set-model" };
    if (selector.length > 512 || /[\0\r\n]/.test(selector)) {
      return { type: "error", message: "Model selector must be a single line of at most 512 characters." };
    }
    return { type: "set-model", model: selector };
  }

  const hooks = /^skip-pre-post-commit-hooks\s+(on|off)$/i.exec(trimmed);
  if (hooks) return { type: "set-hooks", enabled: hooks[1].toLowerCase() === "on" };
  return {
    type: "error",
    message: "Usage: /autogit [show|model <selector|off>|skip-pre-post-commit-hooks <on|off>|help]",
  };
}

export interface ModelPlan {
  files: string[];
  message: string;
}

export function parseModelPlan(response: string, candidates: string[]): ModelPlan {
  const parsed: unknown = JSON.parse(response);
  if (!isRecord(parsed) || !Array.isArray(parsed.files) || typeof parsed.message !== "string") {
    throw new Error("Configured model response must be JSON with files and message fields");
  }
  const allowed = new Set(candidates);
  const files: string[] = [];
  const selected = new Set<string>();
  for (const file of parsed.files) {
    if (typeof file !== "string" || !allowed.has(file) || selected.has(file)) {
      throw new Error("Configured model selected an unknown or duplicate path");
    }
    selected.add(file);
    files.push(file);
  }
  const message = parsed.message.replace(/\s+/g, " ").trim();
  if (files.length > 0 && (!message || message.length > 200 || /[\0\r\n]/.test(parsed.message))) {
    throw new Error("Configured model returned an invalid commit message");
  }
  return { files, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
