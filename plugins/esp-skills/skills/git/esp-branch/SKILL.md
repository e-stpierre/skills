---
name: esp-branch
description: Create a git branch named by the configured convention. Use when starting work that needs a new branch.
argument-hint: "[-s|--slug <slug>] [-t|--type <type>] [-g|--issue <id>] [-b|--base <branch>]"
---

# ESP Branch

## Overview

Create and check out a new branch whose name follows the configured pattern and links to the issue when one is known: `<type>/<issue>_<slug>`, or `<type>/<slug>` without an issue.

## Arguments

### Definitions

Read each option by its short or its long name (`-t fix`, `--type fix` or `--type=fix`).

- **`[-s|--slug <slug>]`** (optional): Normalized to lowercase kebab-case: every run of non-alphanumeric characters becomes one hyphen, and leading or trailing hyphens are dropped. Defaults to a concise kebab-case summary of the task in the conversation, three to five words.
- **`[-t|--type <type>]`** (optional): Branch type (the `{category}` of the pattern), one of `branch.categories` or any other value. Defaults to the type inferred from the work, else `branch.default_category` (`feature`).
- **`[-g|--issue <id>]`** (optional): GitHub issue number of this work, without `#`. Defaults to an issue referenced in the conversation (`#123`, `issue 123`), else none.
- **`[-b|--base <branch>]`** (optional): Branch to create from. Defaults to the current HEAD.

### Values

Arguments: $ARGUMENTS

## Core Principles

- Run without prompting: every missing value comes from the conversation or the defaults
- Paths are relative to this skill's directory (a reference file's paths are relative to that file). Resolve a path to an absolute one before running a command with it: commands run from the user's repository

## Skill-Specific Guidelines

### Configuration

Read the `branch` section once at the start:

```bash
node "../../../scripts/config.mjs" get branch
```

If the command exits with code 1 (invalid config), report its error and stop. If it cannot run at all (no `node`), continue with the defaults.

- `branch.pattern` (default `{category}/{issue}_{name}`): branch name when an issue ID is known
- `branch.pattern_without_issue` (default `{category}/{name}`): branch name when no issue ID is known
- `branch.default_category` (default `feature`): type when none is given or inferred
- `branch.categories` (default `feature, fix, chore, doc, refactor, poc`): suggested types when inferring; other `--type` values work

## Instructions

1. Load the `branch` configuration (see Configuration).
2. Resolve the slug, type, issue and base from the options, filling each missing one per its Definition. Done when each has a value or, for the issue and base, is known to be absent.
3. Build the name: replace `{category}` with the type, `{issue}` with the issue and `{name}` with the slug in `branch.pattern` when an issue is known, else in `branch.pattern_without_issue`.
4. Check the name before creating it:
   - **Valid**: `git check-ref-format --branch <name>` must succeed; otherwise report the invalid name and stop
   - **New**: when `git rev-parse --verify --quiet refs/heads/<name>` succeeds, the branch already exists: report it and stop, without switching to it
   - **Working tree**: when `git status --porcelain` is not empty, the uncommitted changes carry over to the new branch; note it in the report and continue
5. Create it: with a base, `git checkout -b <name> <base>`; otherwise `git checkout -b <name>`. Done when `git branch --show-current` prints the new name.
6. Report the created branch name, and the carried-over changes when step 4 found any.

## Output Guidance

Provide a brief confirmation message:

**On success:**

```text
Created and switched to branch: feature/123_add-authentication
```

With uncommitted changes, add `Uncommitted changes carried over to the new branch.`

**On error:**

```text
Failed to create branch: <error message from git>
```
