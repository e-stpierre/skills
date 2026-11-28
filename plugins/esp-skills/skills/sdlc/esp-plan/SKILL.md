---
name: esp-plan
description: Implementation plan as parseable milestones in a run directory. Use to plan a feature, bug fix or chore before building it, or to amend the remaining milestones of an existing plan.
argument-hint: "[-a|--amend] [-I|--import <path>] [-t|--type <type>] [-i|--interactive <mode>] [-d|--run-dir <path>] [context]"
---

# ESP Plan

## Overview

Explore the codebase and write an implementation plan in plan format 1, the milestones `esp-ship` parses and builds. Use it to plan a feature, bug fix or chore before building it, to convert a task list or a design document (`--import`), or to change the remaining milestones of an existing plan (`--amend`). The plan is written to a run directory, and the skill ends with a short markdown reply.

## Arguments

### Definitions

- **`[-a|--amend]`** (optional): Amend the latest plan in the run directory instead of writing a new one. `[context]` is then the amendment, as text or a file path. Requires `--run-dir` and excludes `--import` (step 1).
- **`[-I|--import <path>]`** (optional): Convert a task list (a checkbox progress list plus one heading per package) or a design document into a plan, with no codebase exploration: one milestone per unchecked package, checked packages listed in `## Out of Scope`, the source path in the `source` frontmatter key.
- **`[-t|--type <type>]`** (optional): Plan type: `feature`, `bug`, `chore` or `auto`. Defaults to `plan.default_type` (`auto`).
- **`[-i|--interactive <mode>]`** (optional): When to stop and ask: `off` (never), `plan` or `all` (ask about B-Scope questions and approve the plan before finishing; other choices take the recommended option, see Asking and Deciding). Defaults to `defaults.interactive` (`off`). Non-interactive sessions always use `off`.
- **`[-d|--run-dir <path>]`** (optional): Run directory owned by a parent skill (esp-ship). Without it, the skill creates its own run under `runs.root`.
- **`[context]`** (optional): The task: free text, an issue URL, or a document path. With `--amend`, the amendment.

### Values

Arguments: $ARGUMENTS

If the line above holds no arguments or an unreplaced placeholder, read them from the message that invoked this skill.

## Additional Resources

- For the plan format, the parser and the amendment rules, see [plan-format.md](../../../references/plan-format.md): read it in step 7, or in step 11 when amending
- For the plan of each type, see [references/feature.md](references/feature.md), [references/bug.md](references/bug.md) and [references/chore.md](references/chore.md): read the one matching the type in step 7
- For classifying choices and when to ask, see [decision-policy.md](../../../references/decision-policy.md): read it before asking or deciding (see Asking and Deciding)
- For the explorer model and effort, see [model-selection.md](../../../references/model-selection.md): read it when `defaults.models.explorer` is not set

## Core Principles

- Explore the codebase before planning, and follow its existing patterns and conventions
- Every milestone is one coherent, reviewable commit that changes code and can be verified by its validation commands
- Write plans to the run directory only: they stay outside the repository and out of git
- Run every script as a shell command. Paths are relative to this skill's directory (a reference file's paths are relative to that file). Resolve a path to an absolute one before running a command with it: commands run from the user's repository. A bare script name (`plan.mjs`) or `scripts/<name>` is the plugin's script, `../../../scripts/<name>` from this directory. `run.json` and `decisions.jsonl` are written by `runs.mjs` only
- Plans size the work only as milestones and their complexity, with no time estimates or deadlines

## Skill-Specific Guidelines

### Configuration

Read the `plan` section and the shared defaults once at the start:

```bash
node "../../../scripts/config.mjs" get plan
node "../../../scripts/config.mjs" get defaults
node "../../../scripts/config.mjs" get ship.budgets.orchestrated.max_milestones
```

With `--run-dir`, add `--run-dir <path>` to each `config.mjs get`: it reads the run's frozen config snapshot (an esp-ship run) in place of the user and project layers, and the live config when the run has none.

If a command exits with code 1 (invalid config), report its error and stop. If it cannot run at all (no `node`), continue with the defaults.

- `plan.default_type` (default `auto`): plan type when `--type` is not given
- `plan.explore_agents` (default `feature: 3`, `bug: 2`, `chore: 2`): explorer subagents per plan type (`0` explores inline)
- `ship.budgets.orchestrated.max_milestones` (default `12`): most milestones in a plan, completed ones included; `esp-ship` halts on a larger plan
- `defaults.interactive` (default `off`): interactive mode when `--interactive` is not given
- `defaults.models.explorer` (default the `low` tier): model and effort passed to each explorer subagent
- `defaults.language` (default `en-US`): language of the plan prose

### Run Directory

The list abbreviates `node "../../../scripts/runs.mjs"` as `runs.mjs` (same for `plan.mjs`). Every `runs.mjs` call except `create` takes `--run-dir <path>`:

- **Own run (no `--run-dir`)**: `runs.mjs create <slug> --title <title> --workflow esp-plan --repo <repo-root>` (prints `run_dir`)
- **Latest plan**: `runs.mjs plan` (`{ path, version }`, version 0 when there is none)
- **Plan commands** (`lint`, `import`, `batches`, `diff`): see the plan format
- **Decision**: `runs.mjs decision --json '<decision>'` (see the decision policy for fields and `x-esp-class`)
- **Own run finished**: `runs.mjs update --status done`, or `halted` or `awaiting-human` to match the reply status

### Parallel Milestones

`esp-ship` builds milestones that do not depend on each other and touch disjoint files at the same time, in separate worktrees. Shape the milestones so the most work can run in parallel:

- **Depends**: declare a dependency only when the milestone really needs the other one's code. Order alone is not a dependency
- **Files**: list every file the milestone creates or changes, so the list is exhaustive. Keep the lists of milestones that could run at the same time disjoint, and avoid `.` (the whole repository): such a milestone always runs alone
- **Shared scaffolding**: move what several milestones need (a shared type, a config entry, a registry line) into its own early milestone, so the later ones fan out from it instead of touching the same file

### Asking and Deciding

Classify every open choice with the decision policy:

- **A-Fix and B-Decide**: pick the recommended option, record it in the plan (Architecture, Fix Strategy or Scope), and log it as a decision with `phase: plan`
- **B-Scope or Halt** (ambiguity that changes scope or public API): in `plan` or `all` mode, ask. In a non-interactive session or a subagent, write the plan with the safest assumption stated in `## Open Questions`, then end with `Status: needs-decision` and the question in a `Question:` line, so the main session asks (see the decision policy). Standalone with `off`, state the assumption in `## Open Questions` and log it

## Instructions

1. **Parse arguments**: read each option by its short or long name (`-a` or `--amend`, `-t` or `--type`, and so on; `--type=<value>` works too) and `[context]`. Fail with a usage message if `--amend` is given without `--run-dir`, or together with `--import`. When `[context]` is an existing file path, read it; when it is an issue URL, fetch it with `gh issue view` if available. Done when the mode (new, import or amend) and the task are known.
2. **Load configuration** (see Configuration) and resolve the interactive mode: the option, else `defaults.interactive`, and always `off` in a non-interactive session or a subagent.
3. **Resolve the run directory**: use `--run-dir` when given. Otherwise derive a short title from the task and run `runs.mjs create`, and use the printed `run_dir`. Done when the run directory exists.
4. **Amend mode** (`--amend`): skip to step 11.
5. **Import mode** (`--import <path>`): convert the source without exploring the codebase (no explorer subagent), log the import as a decision (`source: policy`, the source path in the rationale), then continue at step 12.
   - **Task list**: run `plan.mjs import <path> --run-dir <run-dir>`, with `--type` unless it is `auto`. It writes `plan.md` with one milestone per unchecked package in dependency order, maps the package dependencies to milestone IDs, and prints the lint report. Fill only what the report names as missing or empty: `**Files**` from the package tasks, and `#### Validation` from the project manifest scripts (`package.json`, `Makefile`, `pyproject.toml`). Keep each package's goal, tasks and acceptance criteria as written, and add no milestone
   - **Design document** (`plan.mjs import` exits with `Not a task list`): write `plan.md` yourself in the plan format, one milestone per step or section of the document, with `source` set to the path. Fill missing details the same way, and state any assumption in `## Open Questions`
6. **Detect the plan type** when it is `auto`: `feature` for new functionality, `bug` for defects and unexpected behavior, `chore` for refactoring, dependencies and maintenance. Log the detected type as a low-risk decision.
7. **Load the type reference** (`references/<type>.md`) and the plan format ([plan-format.md](../../../references/plan-format.md)).
8. **Explore the codebase**: delegate to `plan.explore_agents.<type>` read-only explorer subagents, each with a fresh context window and a distinct focus (affected modules, existing patterns and tests, integration points), with the model and effort of the `explorer` role, in parallel when the harness supports it, otherwise one after another. Without subagents, or with `0`, explore inline in this session. The exploration covers the same ground either way.
   - In Claude Code, use the built-in `Explore` agent type. Done when you know every file each milestone will touch, the patterns it follows, and the validation commands (test, lint, build) the project uses.
9. **Gather requirements**: settle every requirements question of the type reference from the context and the exploration. Classify each question that stays open per Asking and Deciding: decide A-Fix and B-Decide yourself, and ask only B-Scope ones (in `plan` or `all` mode). Done when every question is settled, decided, answered or stated in `## Open Questions`.
10. **Write `plan.md`** in the run directory, following the plan format: frontmatter with `version: 1`, the type-specific context sections, then milestones in dependency order, each one commit with explicit files and validation commands. Keep the plan within `max_milestones`: combine related milestones before going over it. When the work truly needs more, say so in `## Risks` and `## Open Questions` (split the work into several plans). Done when every milestone has every field and subsection of the plan format, and its `**Files**` lists every file step 8 found it touches. Continue at step 12.
11. **Amend**: follow the four steps of Amendments in [plan-format.md](../../../references/plan-format.md), keeping the completed and remaining milestones together within `max_milestones` (as in step 10). Fail when `runs.mjs plan` returns version 0; with no `state.json`, no milestone is completed. Done when `plan.mjs diff` passes and one decision logged the amendment. Continue at step 12.
12. **Plan-lint**: run `plan.mjs lint <plan-file> --max-milestones <max_milestones>` on the written file. Fix every error and lint again until `valid` is true. Resolve each warning, or state in the report why it stays. A shared-file warning is resolved by a real `Depends`, or by moving the shared files to an earlier milestone (see Parallel Milestones).
    - **Parallel batches**: when the plan has two or more milestones, run `plan.mjs batches <plan-file>` (with `--run-dir <run-dir>` for an amendment, so completed milestones are left out) and write its `summary` lines as a list in a `## Parallel Batches` context section, just before `## Milestones` (replace the section of a copied version). Lint again, and for an amendment run `plan.mjs diff` again.
13. **Interactive approval** (`plan` or `all`): present the summary and ask for approval before the reply. Apply requested changes to the same file (the version is final only once approved) and lint again. Done when the user approves.
14. **Update an own run's status**: `runs.mjs update --status done`, or `awaiting-human` when a question is open (see Asking and Deciding).
15. **Report** the summary, then end with the reply (see Output Guidance): `Status: done` (or `needs-decision` with the `Question:` line), and a `Summary:` naming the plan path, its version and the milestone IDs. For an import, name the source; for an amendment, the amendment decision ID and the affected milestones.

## Output Guidance

A short summary, then the reply of `../../../references/decision-policy.md` (Replies):

```text
Plan written to <run-dir>/plan.md (version 1, feature)

## Add OAuth login
- M1: Add the OAuth provider (medium)
- M2: Add the login route (low, depends on M1)

Decisions: 2 logged (type detected as feature; session store reused)
Open questions: none
Plan-lint: passed

Next: esp-ship --run-dir <run-dir>

Status: done
Summary: Planned Add OAuth login in 2 milestones (M1, M2): <run-dir>/plan.md, version 1, feature
```

Show the `Next:` line, the skill to invoke next with its arguments, only for an own run (no `--run-dir` given). For an amendment, list the changed, added and removed milestones and the amendment decision ID instead of the full milestone list.
