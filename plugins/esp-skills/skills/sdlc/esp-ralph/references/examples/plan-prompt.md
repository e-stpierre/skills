# Ralph Task: Add CSV export to the reports page

**Repository**: /home/dev/repos/reports-app

## Source

`/home/dev/.esp-skills/runs/2026-11-16-csv-export/plan.md`: the esp-plan plan of the feature (format 1, four milestones).

## Tracker

The plan's `## Progress Tracking` checklist: a milestone is done when its box is checked. A milestone is in progress when a run note says `Started: M<n>`. Write every milestone note (the commit SHA, decisions, deviations, what a later milestone needs) as a run note starting with its ID, never into the plan: `plan.mjs parse` must keep passing. The plan is in the run directory, outside the repository: never commit it.

## Unit

One milestone.

## Pick Rule

The first unchecked milestone whose **Depends** milestones are all checked.

## Required Reading

1. The plan in full, then the run notes of every milestone already worked on. Where a note contradicts the plan, the note wins.
2. `/home/dev/repos/reports-app/AGENTS.md`.
3. The files the milestone lists under **Files**, and any document it links to.

## Procedure

1. Work on the branch `feature/csv-export`. When it does not exist, create it from an up-to-date `main` with `esp-branch`. Otherwise check it out and pull.
2. Do the milestone's tasks in order, within the files it owns.
3. Append run notes for the milestone: the commit SHA, the decisions you made, any deviation from the plan, and anything a later milestone needs to know.

## Verify

The milestone's **Validation** lines and every acceptance criterion, with the command or inspection it names. Run only the tests related to the change: not the full suite, and no format or lint run before the finish step.

## Commit

One commit per milestone with `esp-commit`, with no milestone label in the title. Push the branch after each commit.

## Conventions

- Use `esp-branch`, `esp-commit` and `esp-pr` for every git operation
- Follow the repository's `AGENTS.md`: US English, ASCII only in code files
- Edit the plan only to check Progress Tracking boxes and to record the pull request URL in the Overview

## Questions

Append an operator question to the run notes only for a choice that changes the design or cannot be undone. Decide everything else alone and log it as a decision.

## Completion

Every box of Progress Tracking is checked and the pull request URL is recorded in the plan Overview.

## Finish

Run `pnpm check` and `pnpm test`, fix what they report, open the pull request with `esp-pr`, and record its URL in the plan Overview.
