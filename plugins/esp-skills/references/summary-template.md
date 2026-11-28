# Summary Template

Paths here are relative to this file's directory, the plugin's `references/`: resolve them to absolute paths before running a command.

The format of `summary.md`, written once per run by the skill that owns the run (`esp-ship`, `esp-orchestrate`) when the run ends, halts, or escalates. `esp-recap` and the PR body read it. Summaries live in the run dir only and are never committed.

## Writing Rules

- Write it from the run artifacts, not from memory: `run.json`, `plan.md` (latest version from `runs.mjs plan`), `decisions.jsonl`, the outcome (`ship.mjs outcome`, or `orchestrate.mjs outcome` for an esp-orchestrate run) and the step records of `ship.json`, the plan versions (`plan.v<N>.md`), and `notes.md` (its operator lines).
- Keep every section. When a section has nothing to report, write `None.` so readers know it was checked.
- Reference decisions by ID (`D003`), milestones by ID (`M2`), and plan amendments by version (`plan.v2.md`).
- The summary answers "what happened and what should I look at", not "how the work was done".
- Check after writing: `node "../scripts/runs.mjs" check <run-dir>/summary.md`.

## Frontmatter

Values are flat scalars (no lists or nested objects), checked by `runs.mjs check`.

| Field               | Required | Value                                                                                                      |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `task`              | Yes      | The run ID (the run directory name)                                                                        |
| `title`             | Yes      | Task title, quoted                                                                                         |
| `status`            | Yes      | Final status: a `run.json` status (`done`, `merged`, `partial`, `halted`, `awaiting-human`, `failed`, ...) |
| `workflow`          | No       | Skill or workflow that owned the run (`esp-ship`, `esp-orchestrate`), or `null`                            |
| `pr`                | No       | Pull request URL, or `null` (an esp-orchestrate run with several pull requests lists them in Units)        |
| `max_risk`          | No       | `low`, `medium`, `high`, or `null` (copy from `run.json`)                                                  |
| `decisions`         | No       | Number of lines in `decisions.jsonl`                                                                       |
| `critical_findings` | No       | Number of critical findings reported during the run                                                        |
| `duration_minutes`  | No       | Minutes between `started_at` and `ended_at`, or `null`                                                     |

## Sections

| Section                            | Content                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outcome                            | One paragraph: what was delivered, the track (`inline` or `orchestrated`, and a track switch), the workspace (kind, and for a worktree its path and cleanup), final status, PR, and what is left |
| Decisions                          | The decisions worth a reviewer's attention (medium and high risk first), one line each with ID and class                                                                                         |
| Surprises                          | What differed from expectations: unexpected code, flaky gates, wrong assumptions in the plan                                                                                                     |
| Critical Findings                  | 🔴 Critical and high-severity findings, how each was resolved or why it is still open                                                                                                            |
| Review Comment Resolution          | Per reviewer: comments fixed, rejected (with reason), deferred; rounds used                                                                                                                      |
| Plan Amendments and Operator Notes | Each plan version after the first with its decision, each operator line of `notes.md`, and what changed because of it                                                                            |
| Deviations from Plan               | Milestones changed, skipped, split, or added, and each skipped phase (`outputs.skipped_phases`, the review gate), with the reason                                                                |
| Follow-ups Created                 | Deferred and discovered items (from `discovered_items`), with type and where they were recorded                                                                                                  |
| Metrics                            | Milestones done, commits, gate retries, final-gates runs and fix rounds, builder reuses, review rounds, duration, models used                                                                    |

## esp-orchestrate Runs

A parent run that shipped several units keeps every section above, written from `orchestrate.mjs outcome`, `decisions.jsonl` of the parent and the `summary.md` of each unit (`units/<id>/summary.md`), and adds a `Units` section right after Outcome:

- **Status**: the outcome status: `merged` (every unit landed), `partial` (some units landed, others stopped or blocked), `awaiting-human`, `halted` or `failed`
- **Outcome**: what landed in which repository, what is left, the dirty checkouts that housekeeping left alone, and the resume command when a unit is not done (the esp-orchestrate skill with `--resume --run-dir <run-dir>`)
- **Units**: one line per unit, in dependency order: ID, kind, repository, status, pull request and merge commit, or the stop reason (a blocked unit names the dependency that stopped)
- **Decisions**, **Critical Findings**, **Review Comment Resolution**: the parent decisions (intake, sizing, merge policy, critical stops), then the items of each unit worth attention, prefixed with the unit ID
- **Metrics**: units landed and stopped, unit mode (subagent or inline), waits and their polls, housekeeping results, duration

```markdown
## Units

- lib-presets (adopt, acme/lib): merged, https://github.com/acme/lib/pull/12, 1a2b3c4
- lib-release (check, acme/lib): done after 6 polls
- app-presets (build, acme/app): awaiting-human, a review comment asks to rename a public export (B-Scope) on https://github.com/acme/app/pull/40
- write-back (build, acme/docs): blocked, dependency app-presets is awaiting-human
```

## Template

```markdown
---
task: 2026-11-10-add-token-refresh
title: "Add token refresh"
workflow: esp-ship
status: merged
pr: https://github.com/o/r/pull/42
max_risk: medium
decisions: 7
critical_findings: 0
duration_minutes: 96
---

# Add token refresh

## Outcome

Token refresh is implemented on the orchestrated track, on a new branch in the main checkout, and merged in PR #42 (squash). The three plan milestones shipped as three commits, plus one review-fix commit. Nothing is left open.

## Decisions

- D004 (B-Decide, medium): refresh tokens are rotated on every use; the alternative kept them for their full lifetime
- D006 (Reject, low): rejected the bot suggestion to cache tokens in localStorage, it contradicts the security guidelines

## Surprises

- The existing HTTP client retried 401 responses on its own, so M2 removed that retry instead of wrapping it.

## Critical Findings

None.

## Review Comment Resolution

- claude[bot]: 5 comments, 3 fixed, 1 rejected (D006), 1 deferred (follow-up); 2 rounds

## Plan Amendments and Operator Notes

- Operator: "Keep the old endpoint for one release" -> `plan.v2.md` (D007) amended M3 to keep `/auth/renew` as a deprecated alias

## Deviations from Plan

- M3 kept the deprecated alias (`plan.v2.md`, D007).
- No phase was skipped: the review gate ran the internal review (D005: 9 files, 412 lines, M2 is `high`).

## Follow-ups Created

- follow-up: "Remove the deprecated /auth/renew alias" (discovered item of step fix-review)

## Metrics

- Milestones: 3 of 3, commits: 4, gate retries: 1 (M2 lint), final gates: 1 run, 0 fix rounds, builder reuses: 1 (M3 continued the M2 builder), review rounds: internal 1, PR 2
- Duration: 96 minutes; builder opus, reviewer opus (high), verifier sonnet
```
