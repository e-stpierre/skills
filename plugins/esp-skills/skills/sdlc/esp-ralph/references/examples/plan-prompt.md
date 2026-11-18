# Ralph Task: Add CSV export to the reports page

**Repository**: /home/dev/repos/reports-app

## Source

`/home/dev/.esp-skills/runs/2026-11-16-csv-export/plan.md`: the esp-plan plan of the feature (format 1, four milestones).

## Tracker

The run notes: a milestone is done when a note says `Done: M<n>`, and in progress when a note says `Started: M<n>`. Milestone notes go to the run notes too, starting with the milestone ID, and the plan stays unchanged, so it keeps passing `plan.mjs parse`. The plan is in the run directory, outside the repository and out of git.

## Unit

One milestone.

## Pick Rule

The first milestone with no `Done:` note whose **Depends** milestones all have one.

## Required Reading

1. The plan in full, then the run notes of every milestone already worked on. Where a note contradicts the plan, the note wins.
2. `/home/dev/repos/reports-app/AGENTS.md`.
3. The files the milestone lists under **Files**, and any document it links to.

## Procedure

1. Work on the branch `feature/csv-export`. When it does not exist, create it from an up-to-date `main` with `esp-branch`. Otherwise check it out and pull.
2. Do the milestone's tasks in order, within the files it owns.
3. Append run notes for the milestone: `Done: M<n>` with the commit SHA, the decisions you made, any deviation from the plan, and anything a later milestone needs to know.

## Verify

The milestone's **Validation** lines and every acceptance criterion, with the command or inspection it names. Run only the tests related to the change, and leave the full suite, format and lint to the finish step.

## Commit

One commit per milestone with `esp-commit`, with no milestone label in the title. Push the branch after each commit.

## Conventions

- Use `esp-branch`, `esp-commit` and `esp-pr` for every git operation
- Follow the repository's `AGENTS.md`: US English, ASCII only in code files
- Never edit the plan: progress, milestone notes and the pull request URL go to the run notes

## Questions

Append a question for the user to the run notes only for a choice that changes the design or cannot be undone. Decide everything else alone and log it as a decision.

## Completion

Every milestone of the plan has a `Done: M<n>` note and a run note records the pull request URL.

## Finish

Run `pnpm check` and `pnpm test`, fix what they report, open the pull request with `esp-pr`, and record its URL in a run note (`PR: <url>`).
