---
name: esp-merge
description: Merge a pull request once its objective conditions hold. Use when asked to merge a PR.
argument-hint: "[-n|--dry-run] [-m|--method <method>] [-i|--interactive <mode>] [-p|--pr <pr>] [-d|--run-dir <path>]"
---

# ESP Merge

## Overview

Merge a pull request only when objective conditions hold, with the merge method the repository allows. `scripts/merge-ready.mjs` checks the conditions and resolves the method; the skill acts on its outcome: rebase a branch that is behind, wait for pending checks, then merge or report why not. The remote branch and the task worktree are cleaned up per config.

## Arguments

### Definitions

Read each option by its short or its long name (`-m squash`, `--method squash` or `--method=squash`).

- **`[-n|--dry-run]`** (optional): Check the conditions and resolve the method, rebase nothing, merge nothing. The outcome reports what would happen.
- **`[-m|--method <method>]`** (optional): `repo`, `squash`, `rebase` or `merge`. Defaults to `merge.method` (`repo`: pick from what the repository allows). An explicit method the repository does not allow is an error, never a silent fallback.
- **`[-i|--interactive <mode>]`** (optional): `off`, `plan` or `all`. Only `all` stops for a confirmation before merging; `plan` behaves like `off` in this skill. Defaults to `defaults.interactive` (`off`). Headless sessions always use `off`.
- **`[-p|--pr <pr>]`** (optional): Pull request number, `#<number>`, or URL. Defaults to the pull request of the current branch.
- **`[-d|--run-dir <path>]`** (optional): Run directory owned by a parent skill (esp-ship). Halt decisions and the run status count as halt signals, the method decision goes to the run, and under esp-ship the outcome is recorded as step `merge` in `ship.json`. Without it, no run is created.

### Values

Arguments: $ARGUMENTS

## Additional Resources

- For the Halt class, the `ship.halt_on` stop conditions and the reply format (Replies), see [decision-policy.md](../../../references/decision-policy.md): read it before halting or reporting
- For how the script resolves the method, see [merge-script.md](references/merge-script.md): read it to explain a method choice

## Core Principles

- The script decides whether a pull request may merge, never the model. Every merge goes through `merge-ready.mjs merge`, the only merge command
- Unmet branch protection ends `awaiting-human`. Hard guardrail: no `--admin`, no disabling rules, no dismissing reviews
- A halted task never merges. A Halt decision in the run blocks the merge until an operator decision references it
- The only force-push is `git push --force-with-lease` of the pull request's own head branch, right after a rebase. The base branch is never pushed
- Re-run the gates after every rebase, and push only a rebase whose gates pass
- The script waits, the session sleeps: wait for checks with the script in the background, never with polling or `sleep` loops in the session
- Run every script with Bash, with the literal `"${CLAUDE_PLUGIN_ROOT}/scripts/..."` path. The outcome always comes from the script

## Skill-Specific Guidelines

### Configuration

Read the sections once at the start:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get merge
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get worktrees
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get defaults
```

With `--run-dir`, add `--run-dir <path>` to each `config.mjs get`: it reads the run's frozen config snapshot (an esp-ship run) in place of the user and project layers, and the live config when the run has none.

If a command exits with code 1 (invalid config), report its error and stop. If it cannot run at all (no `node`), stop: the merge conditions need the script.

- `merge.enabled` (default `true`): `false` reports and leaves the pull request open
- `merge.method` (default `repo`): `repo` resolves the method from the repository, else force one method
- `merge.preference` (default `["squash", "rebase", "merge"]`): order used when the repository allows several methods
- `merge.delete_branch` (default `true`): delete the remote head branch after the merge (never a fork branch), and the local branch (see Local Cleanup)
- `merge.require_resolved_threads` (default `true`): unresolved review threads block the merge
- `merge.require_green_checks` (default `true`): every check must pass. `false`: only the required checks
- `merge.use_auto_merge` (default `false`): with checks pending, enable GitHub auto-merge instead of waiting
- `merge.checks_timeout_minutes` (default `30`): time limit of the wait for pending checks
- `merge.poll_seconds` (default `30`): seconds between check polls during that wait (read by `merge-ready.mjs` itself)
- `worktrees.root`, `worktrees.cleanup` (defaults `~/.esp-skills/worktrees`, `on-merge`): remove the task worktree after the merge, unless cleanup is `never`
- `defaults.interactive` (default `off`): interactive mode when `--interactive` is not given

### Scripts

Every `merge-ready.mjs` call takes the `--pr` value as `<pr>` (omitted without it), plus `--run-dir <path>`:

- **Check**: `merge-ready.mjs check [<pr>] [--method <m>]` (report: `ready`, `outcome`, `conditions`, `method`)
- **Wait for checks**: `merge-ready.mjs check [<pr>] --wait` (polls every `merge.poll_seconds` up to `merge.checks_timeout_minutes`)
- **Merge**: `merge-ready.mjs merge [<pr>] [--method <m>] [--dry-run]` (prints the outcome JSON; read its `status`, not the exit code: it exits 0 for every status but `failed`)
- **Halt**: `merge-ready.mjs merge [<pr>] --halt "<reason>"` (logs a Halt decision, never merges)
- **Gates after rebase**: `gates.mjs resolve --project-dir <repo>` (plus `--run-dir <path>` when given) prints the gate commands, configured (`ship.gates`) or detected from the project files, in `commands`; run each

Each condition in the report is `pass`, `fail` or `pending`, with a reason. The outcomes:

- `ready`: every condition passes and a method is allowed. Merge
- `pending`: only checks are still running. Wait for checks, then check again
- `behind`: the branch is behind the base. Rebase, then check again
- `conflict`: the branch conflicts with the base. Rebase and resolve, or halt
- `blocked`: draft, changes requested, unresolved threads, failing checks, or no method. Merge reports it (`awaiting-human`)
- `protected`: branch protection or rulesets block the merge (for example a required approval). Merge reports it (`awaiting-human`)
- `halted`: the run is halted, or a Halt decision is not lifted. Merge reports it (`halted`)
- `queued`: already in the merge queue, or auto-merge already on. Merge reports it (`done`)
- `merged`, `closed`: nothing left to merge. Merge reports it

### Rebase and Re-Check

When the outcome is `behind` or `conflict`, and the pull request is not from a fork:

1. The working tree must be clean and on the pull request head branch (`gh pr checkout <pr>` otherwise; in a worktree, work there).
2. `git fetch origin <base>`, then `git rebase origin/<base>`.
3. On conflicts: resolve them only when both sides are clear (for example a changelog or a lockfile, or independent edits) and you can explain the result. Otherwise `git rebase --abort`, then `merge-ready.mjs merge --halt "rebase conflict with <base> in <files>"`, and go to the report.
4. Run every gate command that `gates.mjs resolve` prints. If a gate fails because of the rebase and you cannot fix it in the rebased commits, halt the same way with the failing gate as the reason.
5. `git push --force-with-lease`, then wait for the checks of the new head (see Waiting for Checks) and check again.

Rebase at most 3 times per invocation: a base that keeps moving ends with the `behind` outcome of the last check. A fork pull request is never rebased: the merge reports `behind` or `conflict`.

### Waiting for Checks

Run `merge-ready.mjs check [<pr>] --wait` in the background with an exit notification when the runtime has it (end the turn; the next action is reading the exit notification), else in the foreground with the longest shell timeout. It exits when the outcome is no longer `pending`, or with `timed_out: true`. With `merge.use_auto_merge`, skip the wait: `merge` enables auto-merge on pending checks.

### Interactive Merge

In `all` mode, standalone and not headless: before the merge, show the conditions and the method with its reason, and ask whether to merge. On "no", leave the pull request open: run `merge-ready.mjs merge --dry-run` for the outcome, and with `--run-dir` log the answer with `runs.mjs decision` (`source: operator`, `phase: merge`). In every other mode, merge without asking.

### Local Cleanup

After `outputs.merged` is `true`:

- `outputs.cleanup.worktree.remove` is `true`: leave the worktree (`cd` to `outputs.cleanup.worktree.main`), then `git worktree remove <path>`, without `--force`: a dirty worktree is kept and reported.
- Then, when `merge.delete_branch` is on and the merged head branch exists locally, delete it with `git branch -D <branch>` (the merge on GitHub is confirmed, so a squash or rebase merge does not lose work). When it is the current branch, `git switch <base>` and `git pull --ff-only` first. A branch checked out in another worktree (`git worktree list`) is kept and reported.

## Instructions

1. **Parse arguments**: read every option by its short or long name. Resolve the interactive mode (`-i|--interactive`, else `defaults.interactive`, `off` when headless).
2. **Load configuration** (see Configuration). With `merge.enabled: false`, skip to step 8: `merge` reports it, with no confirmation.
3. **Check prerequisites**: `gh auth status` must succeed, and the pull request must exist. Otherwise report it and stop.
4. **Read user corrections**: with `--run-dir`, the operator lines of `runs.mjs notes --show --run-dir <path>` (marked `(operator)`). A line that says not to merge ends the skill with `merge --halt "<line>"`.
5. **Check**: `merge-ready.mjs check [<pr>] [--method <m>]`. With `--dry-run`, skip to step 8, with no confirmation.
6. **Act on the outcome** (see Scripts): `pending` -> wait for checks and check again; `behind` or `conflict` -> rebase and re-check (see Rebase and Re-Check), except for a fork pull request, which goes to step 7 as is. Done when the outcome is neither `pending`, `behind` nor `conflict`, the pull request is from a fork, or the rebase limit is reached.
7. **Confirm** (`all` mode only, see Interactive Merge), when the outcome is `ready`. Done when the user has answered.
8. **Merge**: `merge-ready.mjs merge [<pr>] [--method <m>] [--dry-run]`. Under esp-ship (`--run-dir` with a `ship.json`), pipe it into `ship.mjs record merge --run-dir <path>`. The script checks again right before merging, so a base that moved since step 6 ends `behind` without merging.
9. **Clean up** (see Local Cleanup) when the pull request merged.
10. **Report** (see Output Guidance), then the reply.

## Output Guidance

A short status with each condition, then the reply of `${CLAUDE_PLUGIN_ROOT}/references/decision-policy.md` (Replies), built from the outcome:

```markdown
### Merge: PR 42

- **Conditions**: open, no halt, not a draft, no changes requested, threads resolved, 4 checks green, up to date with main, protection satisfied
- **Method**: squash (first allowed method in merge.preference [squash, rebase, merge])
- **Rebased**: once, onto main at 7c1e2d3, gates passed
- **Cleanup**: remote branch deleted, worktree removed
```

```markdown
Status: done
Commit: 9b8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e
Summary: Merged #42 at 9b8e7d6 with squash (first allowed method in merge.preference [squash, rebase, merge]).
```

The outcome `status` is `merged` after a merge, `done` when the pull request was queued, set to auto-merge, left open by config or `--dry-run`, `awaiting-human` when a condition is unmet (the unmet conditions are in `blockers`: check again or leave open), `halted` when a halt blocks it, and `failed` when the pull request is closed. Map it to the reply status as Replies says, with the unmet conditions as `Blockers:`.
