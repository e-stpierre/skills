---
name: esp-codex
description: Run a task or a read-only review on the Codex CLI and report its answer. Use when asked to delegate work to Codex or to get a Codex review.
argument-hint: "[-R|--review] [-s|--sandbox <mode>] [-a|--model <model>] [-t|--timeout <minutes>] [-S|--schema <file>] [-d|--run-dir <path>] [task]"
---

# ESP Codex

## Overview

Delegate one declared task, or a read-only review, to the Codex CLI and bring its answer back to this session. The skill runs `codex.mjs`, which calls `codex exec` in a sandbox (`read-only` by default) with no approval prompts, waits for it even past the 10-minute limit of one command, and reports Codex's answer. Codex is a one-shot delegate: it gets the task once, is never steered mid-run, and bills the Codex plan, not the Claude plan. The skill runs only from another harness: inside Codex it stops, because delegating to Codex from Codex is pointless. Other skills and workflows delegate through the `esp-codex` relay agent instead (see `../../../agents/esp-codex.md`).

In Claude Code, a workflow spawns that relay with the `esp-skills:esp-codex` agent type.

## Arguments

### Definitions

- **`[-R|--review]`** (optional): Run a read-only Codex review instead of a task. `[task]` is then the review target: empty for the local changes, a ref, a range (`main..HEAD`), `#<n>` or a pull request URL.
- **`[-s|--sandbox <mode>]`** (optional): `read-only` or `workspace-write`. Defaults to `codex.sandbox` (`read-only`). Ignored with `--review`, which is always read-only.
- **`[-a|--model <model>]`** (optional): Codex model passed to `codex exec`. Defaults to `codex.model`; `null` uses the Codex config.
- **`[-t|--timeout <minutes>]`** (optional): Minutes before the Codex process tree is killed. Defaults to `codex.timeout_minutes` (`30`).
- **`[-S|--schema <file>]`** (optional): JSON Schema file for Codex's final answer (`--output-schema`). Not used with `--review`, which has its own finding schema.
- **`[-d|--run-dir <path>]`** (optional): Run directory owned by a parent skill. `codex.mjs` logs one decision and one notes line there, and writes Codex's answer under `<run-dir>/codex/`.
- **`[task]`** (required unless `--review`): The task for Codex, in full: what to do, where, and what to return.

### Values

Arguments: $ARGUMENTS

If the line above holds no arguments or an unreplaced placeholder, read them from the message that invoked this skill.

## Core Principles

- Pass the task to Codex word for word. Do the task through Codex or not at all: when Codex fails, report the failure and its fix, and let the user choose what comes next
- Default to `read-only`. `--sandbox` sets the mode when given, then a `codex.sandbox` of `workspace-write`. Otherwise use `workspace-write` only when the user asked for it or the task cannot be done without writing (and say so in the report)
- Codex's answer is a second source, not a verdict: report it as Codex's, and verify a claim before acting on it
- Run every script as a shell command, with long option names. Paths are relative to this skill's directory (a reference file's paths are relative to that file). Resolve a path to an absolute one before running a command with it: commands run from the user's repository. A bare script name (`codex.mjs`) or `scripts/<name>` is the plugin's script, `../../../scripts/<name>` from this directory

## Skill-Specific Guidelines

### Configuration

Read the section once at the start:

```bash
node "../../../scripts/config.mjs" get codex
```

If the command exits with code 1 (invalid config), report its error and stop. If `node` is missing, say the skill needs Node 22 and stop.

- `codex.model` (default `null`): Codex model; `null` passes no `--model`
- `codex.sandbox` (default `read-only`): sandbox of a task run
- `codex.timeout_minutes` (default `30`): timeout in minutes

### Codex Failures

The outcome's `failure` names the cause and `fix` the remedy: `missing` (Codex not installed), `login` (run `codex login`), `model` (the model is not available on the Codex plan: pass `--model` or set `model` in `~/.codex/config.toml`), `limit` (a Codex usage limit), `other` (unknown cause). On the first `other` failure, run `node "../../../scripts/codex.mjs" doctor` and report its one-line summary.

## Instructions

1. **Refuse inside Codex**: tell from the session whether it runs in Codex. Your own knowledge of the harness you run in counts (you are Codex, or the session says it is the Codex CLI). Also check the environment with a command: `node -e "console.log(Object.keys(process.env).filter(k => k.startsWith('CODEX_')).join(' '))"`; `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED` or `CODEX_THREAD_ID` in the output confirms it (`CODEX_HOME` or `CODEX_API_KEY` alone does not: a user can set them anywhere). When either signal says Codex, stop with this message and do nothing else (no script, no file, no second opinion from another model): `esp-codex delegates work to Codex, and this session already runs in Codex. Do the task here instead of delegating it.` Done when the harness is not Codex.
2. **Parse arguments**: read each option by its short or long name (`-R` or `--review`, `-S` or `--schema`, and so on; `--timeout=<n>` works too) and `[task]`. Without `--review` and without a task, ask for the task (in a non-interactive session: report the missing task and stop). Done when the mode and the task or target are known.
3. **Load configuration** (see Configuration), and resolve the sandbox, model and timeout from the arguments first, then the config. Done when all three have a value.
4. **Write the prompt** (task mode only): write the task, word for word, to a file outside the repository: `<run-dir>/codex/prompt-<slug>.md` with `--run-dir`, otherwise the system temp directory, where `<slug>` is a few kebab-case words of the task. Done when the file holds the task.
5. **Run**:
   1. With a Codex timeout of 9 minutes or less, run in the foreground, with a command timeout of 600000 ms:

      ```bash
      node "../../../scripts/codex.mjs" run --prompt "@<prompt file>" --sandbox <mode> --timeout-minutes <n> [--model <m>] [--output-schema <file>] [--run-dir <path>]
      node "../../../scripts/codex.mjs" review [target] --timeout-minutes <n> [--model <m>] [--run-dir <path>]
      ```

   2. With a longer Codex timeout, add `--detach`. It prints `{ status: running, pid, out, status_path }` at once. Tell the user Codex is running, then wait only through `node "../../../scripts/codex.mjs" wait --status-path <status_path> --max-minutes 9`, with a command timeout of 600000 ms, and repeat it while it prints `status: running`, so each call stays under the 10-minute command limit.
   3. Done when the outcome has `status` `done` or `failed`.

6. **Read the result**: from the outcome JSON, take `status`, `summary`, `usage`, `duration_seconds` and, on a failure, `reason`, `failure` and `fix`. Read the `out` file for Codex's full answer; with `--schema`, use `result`; with `--review`, use `findings`. On a failure, see Codex Failures. Done when the answer or the failure is known.
7. **Report** (see Output Guidance). With `workspace-write`, list the files Codex changed (`git status --short`), and leave them uncommitted for the user to review.

## Output Guidance

Reply in short markdown for the user:

- **Task**: one line with the outcome, the sandbox, the duration and the tokens, then Codex's answer as it is
- **Review**: one line with the target and the finding count, then one bullet per finding: `<severity> <file>:<line> - <title>`, with its evidence and fix on the next line. Say that the findings are unverified
- **Failure**: one line `Codex failed (<reason>): <summary>`, then the fix to try

When another skill called this one, end with the reply format of `../../../references/decision-policy.md` (Replies), and nothing after it: `Status: done` or `failed`, and `Summary:` with what Codex did or why it failed.

## Templates

A task report:

```markdown
**Codex done** (read-only, 41 s, 18k input tokens)

The scripts directory holds 14 entry points: `branch.mjs`, `codex.mjs`, `config.mjs`, ...
```

A review report:

```markdown
**Codex review** of `main..HEAD`: 2 findings (unverified)

- high `src/export/csv.js:42` - Quotes inside a field are not escaped
  Evidence: `row.join(",")` writes raw values. Fix: escape `"` as `""` and quote the field
- low `src/export/csv.js:7` - Unused import of `path`
```
