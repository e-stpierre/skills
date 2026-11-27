---
name: esp-pr
description: Create a pull request with a title and description sized to the change. Use when asked to open a PR.
argument-hint: "[-D|--draft] [-b|--base <branch>] [-d|--run-dir <path>]"
---

# ESP PR

## Overview

Create a pull request with the GitHub CLI, or update the open one of the current branch, with a title and description sized to the scope and impact of the changes and an AI attribution line at the end of the body. With a run directory and `pr.body_from_run`, the body is rendered from the run artifacts (plan milestones, decisions, review resolution, follow-ups) instead of being written from the diff.

## Arguments

### Definitions

Read each option by its short or its long name (`-b main`, `--base main` or `--base=main`).

- **`[-D|--draft]`** (optional): Create the PR as a draft. Defaults to `pr.draft` (`false`).
- **`[-b|--base <branch>]`** (optional): Target branch of the PR. Defaults to `pr.base`, or the repository default branch when `pr.base` is `null`.
- **`[-d|--run-dir <path>]`** (optional): Run directory of the task (from `esp-ship`). With `pr.body_from_run`, the body is rendered from its artifacts, and the PR URL is recorded in its `run.json`. Defaults to none.

### Values

Arguments: $ARGUMENTS

## Core Principles

- The title conveys the primary change; the description gives the why and the context, since the diff already shows the what
- One PR per branch: when the branch already has an open PR, update it instead of creating another, so a re-run after an interruption is safe
- Paths are relative to this skill's directory (a reference file's paths are relative to that file). Resolve a path to an absolute one before running a command with it: commands run from the user's repository

## Skill-Specific Guidelines

### Configuration

Read the `pr` section, the commit style and the shared language once at the start:

```bash
node "../../../scripts/config.mjs" get pr
node "../../../scripts/config.mjs" get commit.style
node "../../../scripts/config.mjs" get defaults.language
```

With `--run-dir`, add `--run-dir <path>` to each `config.mjs get`: it reads the run's frozen config snapshot (an esp-ship run) in place of the user and project layers, and the live config when the run has none.

If a command exits with code 1 (invalid config), report its error and stop. If it cannot run at all (no `node`), continue with the defaults.

- `pr.base` (default `null`): base branch; `null` uses the repository default branch (`gh repo view --json defaultBranchRef`)
- `pr.draft` (default `false`): open every PR as a draft
- `pr.attribution` (default `true`): append the AI attribution line to the body
- `pr.body_from_run` (default `true`): with `--run-dir`, build the body from the run artifacts
- `pr.body_sections` (default `summary, milestones, decisions, review-resolution, follow-ups`): sections of a body built from the run, in order
- `commit.style` (default `plain`): title format, as for commits. `plain`: imperative mood, capitalized first letter, no period. `conventional`: `type(scope): subject`
- `defaults.language` (default `en-US`): language of the PR title and body

### Size Categories

The size of the change sets the length of a body written from the diff:

- **Small** (under 50 changed lines, one focused change): a one-line description, then the attribution line
- **Larger** (50 lines or more): `## Summary` and `## Details`, then the attribution line

Small:

```bash
gh pr create --title "Fix typo in README" --body "Corrects spelling error

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Larger:

```bash
gh pr create --title "<title>" --body "## Summary
<1-2 sentence overview>

## Details
- <Key change 1 with context>
- <Key change 2 with context>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

## Instructions

1. Load the `pr` configuration (see Configuration) and resolve the base branch per the `--base` Definition.
2. Verify the current branch is not the base branch; when it is, report it and stop.
3. Push the current branch (`git push -u origin HEAD`) when `git status -sb` shows no upstream or commits ahead of it. Done when `git status -sb` shows the branch up to date with its upstream.
4. Fetch the base and read the scope: `git fetch origin <base>`, `git log origin/<base>..HEAD --oneline`, and `git diff origin/<base>...HEAD --stat`. Done when you know every commit in the PR and its changed-line count.
5. Write the title and body in `defaults.language`. The title follows `commit.style` (with `conventional`, the subject below becomes `type(scope): subject`):
   - **Title from the run** (with `--run-dir`): the plan title, the `title` frontmatter key of the plan that `runs.mjs plan --run-dir <path>` names, else the run title (`title` in `<path>/run.json`)
   - **Title from the diff** (otherwise): the primary change across the commits of step 4
   - **From the run** (with `--run-dir` and `pr.body_from_run`): write a 1-2 sentence summary of why the change exists, then render the body with `node "../../../scripts/runs.mjs" pr-body --run-dir <path> --summary "<summary>" --out <path>/pr-body.md`. It applies `pr.body_sections` and `pr.attribution`.
   - **From the diff** (otherwise): pick the size category from the stat and write the body per Size Categories, ending with the attribution line unless `pr.attribution` is `false`.
6. Look for an open PR on the current branch: `gh pr view --json url,state,isDraft`. A PR with `state` `OPEN` is the existing PR; a non-zero exit (no PR), or a closed or merged PR, means none.
7. Create or update the PR:
   - **No open PR**: `gh pr create --base <base> --title "<title>"`, plus `--body-file <path>/pr-body.md` for a body from the run or `--body "<body>"` otherwise, plus `--draft` when `-D` or `--draft` is present or `pr.draft` is `true`. Done when `gh` prints the PR URL
   - **Open PR**: `gh pr edit <url> --base <base> --title "<title>"` with the same `--body-file` or `--body`, and leave its draft state as is. Done when `gh` prints the PR URL
8. With `--run-dir`, record the URL: `node "../../../scripts/runs.mjs" update --run-dir <path> --pr <url>`.
9. Report the PR URL and title, as `PR created` or `PR updated`.

## Output Guidance

Provide a brief confirmation message:

**On success:**

```text
PR created: https://github.com/owner/repo/pull/123
Title: Add user authentication
```

When the branch already had an open PR, the first line is `PR updated: <url>`.

**On error:**

```text
Failed to create PR: <error message from gh CLI>
```

**Called by another skill** (`esp-ship`): end with the reply of `../../../references/decision-policy.md` (Replies):

```markdown
Status: done
Summary: PR created: https://github.com/owner/repo/pull/123
```

With an existing PR, the `Summary:` line starts with `PR updated:`.
