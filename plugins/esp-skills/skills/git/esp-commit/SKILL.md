---
name: esp-commit
description: Commit the current changes with a structured message. Use when asked to commit.
argument-hint: "[-m|--message <title>]"
---

# ESP Commit

## Overview

Commit the current changes with a concise title, an optional bullet-point description, and an AI attribution trailer naming the model.

## Arguments

### Definitions

Read each option by its short or its long name (`-m "..."`, `--message "..."` or `--message=...`).

- **`[-m|--message <title>]`** (optional): The commit title, used as given apart from the plan step prefix (see Plan Step Reference). Defaults to a title generated from the changes.

### Values

Arguments: $ARGUMENTS

## Core Principles

- The title names the main task completed: 50 characters ideal, 120 at most
- The description is 1-5 bullets on the key aspects of a substantial change; a small change has none
- Never commit on the repository default branch or on a detached HEAD, unless the user explicitly asked in this conversation to commit on the default branch
- Paths are relative to this skill's directory (a reference file's paths are relative to that file). Resolve a path to an absolute one before running a command with it: commands run from the user's repository

## Skill-Specific Guidelines

### Configuration

Read the `commit` section and the shared language once at the start:

```bash
node "../../../scripts/config.mjs" get commit
node "../../../scripts/config.mjs" get defaults.language
```

If a command exits with code 1 (invalid config), report its error and stop. If it cannot run at all (no `node`), continue with the defaults.

- `commit.style` (default `plain`): title format. `plain`: imperative mood, capitalized first letter, no period. `conventional`: `type(scope): subject` (Conventional Commits)
- `commit.co_author` (default `true`): add the `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer
- `commit.plan_step_prefix` (default `true`): add the plan step prefix (`[Task N]`, `[Milestone N]`) when following a plan
- `defaults.language` (default `en-US`): language of the commit title and description

### Plan Step Reference

When actively following a plan with numbered steps and `commit.plan_step_prefix` is `true`, the title starts with the step these changes complete, in brackets:

- **Task-based plans**: `[Task N]` (e.g., `[Task 1]`, `[Task 8]`)
- **Milestone-based plans**: `[Milestone N]` when committing after completing a milestone
- **Nested plans**: `[Task M.N]` for tasks within milestones (e.g., `[Task 1.1]`, `[Task 2.3]`)

Without a plan, the title has no brackets. With `conventional` style, the prefix comes first.

**Examples:**

- `[Task 8] Update CLI with orchestrator integration`
- `[Milestone 1] Complete authentication module`
- `[Task 2] feat(auth): add token refresh`
- `Add helper function for date parsing` (no plan context)

## Instructions

1. Load the `commit` configuration (see Configuration).
2. Check the branch: `git branch --show-current` prints nothing on a detached HEAD; report it and stop. Read the default branch with `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`, or `git symbolic-ref --short refs/remotes/origin/HEAD` without `gh` (strip `origin/`). When the current branch is the default branch, report it and stop, unless the user explicitly asked in this conversation to commit on it. Done when the current branch is a named branch other than the default one, or the user asked for the default one.
3. Run `git status`. With nothing to commit, report it and stop.
4. Run `git diff --staged`; when nothing is staged, stage the tracked changes with `git add -u`. Stage an untracked file only when it belongs to the change and holds no secret or build output. Done when `git diff --staged` shows the full change.
5. Write the message in `defaults.language`:
   - **Title**: the plan step prefix (see Plan Step Reference), then `--message` as given, otherwise a title per `commit.style` and Core Principles
   - **Description**: per Core Principles
   - **Trailer**: the `Co-Authored-By` line with your model name, unless `commit.co_author` is `false`
6. Commit with a HEREDOC so the formatting survives:

   ```bash
   git commit -m "$(cat <<'EOF'
   [Task N] <title>

   - bullet 1 (optional)
   - bullet 2 (optional)

   Co-Authored-By: Claude <model> <noreply@anthropic.com>
   EOF
   )"
   ```

7. Report the commit hash and title, read from `git log -1 --format='%h - %s'`. Done when it shows the new title.

## Output Guidance

Provide a brief confirmation message:

**On success:**

```text
Committed: abc123f - [Task 3] Add authentication module
```

**On error:**

```text
Failed to commit: <error message from git>
```

**On the default branch or a detached HEAD:**

```text
Not committed: main is the default branch. Create a branch first (/esp-skills:esp-branch).
```
