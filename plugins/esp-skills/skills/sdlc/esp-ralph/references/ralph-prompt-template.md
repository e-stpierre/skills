<!--
RALPH PROMPT TEMPLATE

esp-ralph fills this template into <run-dir>/prompt.md, the task file of the esp-ralph-loop
workflow. Every iteration is a fresh esp-iterator agent that reads the whole file first.

FILLING RULES:
- Replace every {{slot}} and delete every HTML comment, this one included. The written prompt
  holds no placeholder and no comment
- Write only what is specific to this task. The generic loop rules already live in
  agents/esp-iterator.md and are never repeated here: one unit per iteration, fresh context,
  reading the run notes and applying operator lines, checking completion first, resuming an
  in-progress unit, marking the start, splitting a unit that does not fit, never leaving the
  branch broken, no human watching, spikes, human-only checks, blocked handling, never merging,
  pushing to the default branch or force-pushing, never committing local tracker files
- Never add a loop signal block (a JSON completion or failure block) or a completion promise.
  The iteration reports its status through the workflow schema
- Write paths as absolute paths. Keep each section short: a sentence or a few bullets
- A slot the source does not answer is asked with AskUserQuestion, or filled with the default
  its comment gives when the session is headless
-->

# Ralph Task: {{title}}

**Repository**: {{repo}}

## Source

{{source}}

<!--
The document the loop works from, as an absolute path, with one line on what it is
(e.g. "The esp-plan plan of the feature", "The findings document of the audit").
For a free-text task: "None: the task is described below", then the task in a few sentences.
-->

## Tracker

{{tracker}}

<!--
Where progress lives and how a unit is marked:
- done (e.g. "check its box in the `## Progress Tracking` checklist")
- in progress (e.g. "a run note says `Started: <unit>`")
- whether the tracker file is local (git-ignored or outside the repo: never committed)
For a free-text task: "The run notes: a unit is done when a note says `Done: <unit>`,
in progress when a note says `Started: <unit>`".
-->

## Unit

{{unit}}

<!--
What one iteration takes on (e.g. "One milestone", "One finding", "One item of the task list
below"). For a free-text task, list the units here as a short numbered list.
-->

## Pick Rule

{{pick_rule}}

<!--
How the next unit is chosen, e.g. "The first unchecked milestone whose Depends are all checked".
Name any filter (e.g. "only findings with `Decision: fix`; skip `wontfix` and `defer`").
-->

## Required Reading

{{required_reading}}

<!--
What to read before working, in order, as a numbered list: the source in full, the
repository's AGENTS.md / CLAUDE.md, the files the unit lists, the documents it links.
-->

## Procedure

{{procedure}}

<!--
The task-specific steps between picking a unit and recording it, as a numbered list:
branch setup (the branch name, created from an up-to-date default branch with esp-branch
when missing, otherwise checked out and pulled), how to implement the unit, what to update
besides the code (docs, changelog). Leave out the generic steps of esp-iterator.
-->

## Verify

{{verify}}

<!--
The commands that prove a unit, e.g. "the unit's Validation lines" or a fixed list such as
`node --test <files>`. Say what to scope (only the tests related to the change) and what
never to run per unit (e.g. the full suite or format and lint, left to the finish step).
-->

## Commit

{{commit}}

<!--
The commit convention, e.g. "One commit per milestone with esp-commit, no plan label in the
title; push the branch after each commit". Name the commit skill and when to push.
-->

## Conventions

{{conventions}}

<!--
Repository rules the loop must follow, from AGENTS.md, CLAUDE.md and the source: skills to
use, files never to edit, language and style rules, which notes to write and where. Default
when nothing applies: "Follow the repository's AGENTS.md".
-->

## Questions

{{questions}}

<!--
Where a blocker or a costly choice goes and the bar for raising one, e.g. "Append an operator
question to the run notes only for a choice that changes the design or cannot be undone;
decide everything else alone and log it as a decision". Default: that sentence.
-->

## Completion

{{completion}}

<!--
When the loop is done, as a checkable condition, e.g. "Every box of Progress Tracking is
checked and the pull request URL is recorded in the plan header".
-->

## Finish

{{finish}}

<!--
The last step, run once when the last unit is done, e.g. "Run `pnpm check`, open the pull
request with esp-pr, and record its URL in the plan header". Default: "None: the loop ends
with the last unit".
-->
