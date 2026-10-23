---
description: Prevent agent-issued Git commits unless the user explicitly asks.
alwaysApply: true
---

The agent MUST NOT run or invoke `git commit` through Bash, tools, scripts, subprocesses, or wrappers unless the user explicitly asks the agent to make a Git commit.

This restriction applies to ordinary and configured-hook-bypass commit commands. Do not stage changes with the intent to commit them unless the user explicitly asks.

The host-side `@snazzie/omp-autocommit` extension may commit selected task changes after a successful todo completion. That automatic action is not an agent-issued Git command. Do not try to initiate, duplicate, or bypass the extension's commit handling.
