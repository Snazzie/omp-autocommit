# @snazzie/omp-autocommit

Task-scoped automatic Git commits for Oh My Pi. Package ships an OMP extension, `/autogit` configuration command, and always-applied rule that prevents agent-issued commits unless the user explicitly requests one. It uses OMP's public extension and SDK APIs; it does not clone or modify OMP core.

## Install

Add the GitHub marketplace and install the project-scoped plugin:

```text
/marketplace add snazzie/omp-autocommit
/marketplace install --scope project autogit@omp-autocommit
```

For local development, link the package:

```sh
omp plugin link /absolute/path/to/omp-autocommit
```

The extension requires OMP 18.4.12 or newer, which provides the required `createAgentSession` child-session SDK options. The package declares this minimum as a peer dependency.

## Configure

Run these commands in an OMP session:

```text
/autogit
/autogit model @autogit
/autogit model off
/autogit skip-pre-post-commit-hooks on
/autogit skip-pre-post-commit-hooks off
```

`/autogit` and `/autogit show` display current settings. `/autogit model` also displays settings; use `off` to return to deterministic task-name commit messages. The model selector accepts any value resolvable by OMP, including a role alias such as `@autogit`.

Settings persist in the project-local `.omp/autogit.json` file. Hook bypass defaults to off. When enabled, AutoGit skips only Git's `pre-commit` and `post-commit` hooks for that automatic commit; `prepare-commit-msg`, `commit-msg`, and other active hooks still run. This setting does not alter Git configuration or affect other Git commands.

## Behavior and safety

- AutoGit listens only to successful `todo` tool results and deduplicates by tool-call ID, not phase snapshots, so later re-entry into an earlier state remains observable. It snapshots `HEAD` and dirty paths when a unique task enters `in_progress`; it considers that task complete only after a later successful todo result transitions the same exact task content to `completed`.
- Without a configured model, AutoGit commits all safe changed paths after that task's baseline with subject `Complete task: <task content>`.
- With a configured model, a separate in-memory child OMP SDK session sends the task name and bounded candidate diffs to the selected provider. It can select only candidate paths and return a single-line commit subject. It has no tools, cannot run Git, and retries are disabled. Unavailable models, invalid output, changed workspaces, or other review failures skip the commit; there is no deterministic fallback.
- Paths already dirty at task start are never included. Commits use explicit paths, so unrelated staged changes are not committed. No commit is made for an empty diff, failed/repeated todo result, ambiguous task identity, or unsafe Git baseline.
- Renames, copies, unresolved conflicts, duplicate task content, missing `HEAD`, and paths outside the working tree fail closed. Task identity uses exact task content because OMP todo tasks have no IDs; reused content after removal, closure, or reinitialization is skipped.
- Model review input is capped at 96 KiB. Untracked regular UTF-8 files are included for review; binary, non-UTF-8, and symlink contents are omitted, but raw file hashes and symlink targets remain part of workspace-stability checks.
- Automatic commits run inside the extension's host callback. They do not send a message or start a turn in the primary session.

The bundled always-applied rule is in `rules/autogit-safety.md`. It tells agents not to run or invoke `git commit`, including hook-bypass variants, unless the user explicitly asks. The extension's host-side automatic commit is permitted by that rule and is not an agent-issued Git command.

## Tests

Before local development or E2E use, install the OMP SDK peer dependency:

```sh
bun install
```

Deterministic core tests:

```sh
bun test
```

The real OMP RPC E2E fixture uses an isolated temporary Git repository, real hooks, and the installed OMP executable. It requires an authenticated model selector:

```sh
OMP_TEST_MODEL='<provider/model-selector>' bun run test:e2e
```

Set `OMP_BIN` when the executable is not named `omp`. `AUTOGIT_TEST_REVIEW_MODEL` optionally selects a different model for AutoGit's configured-model path; otherwise the E2E uses `OMP_TEST_MODEL` for both agent work and commit review. The fixture validates nested working-directory path handling, repeated todo snapshots, staged-index preservation, untracked-index rollback after hook failure, retained path-sensitive `prepare-commit-msg` and `commit-msg` hooks, bypass of only `pre-commit` and `post-commit`, model commits, and fail-closed review.
