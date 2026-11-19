# Plan Phase

The orchestrated track always ends its plan phase with a plan file in plan format 1, because the milestone loop builds from it. `ship.mjs next` returns `phase: plan` with `plan_source`, `plan_mode` and `latest_plan` (the latest plan version in the run directory, or `null`).

## By Plan Source

Each source ends with `phase plan --status done`, which takes `latest_plan` unless `--plan <path>` is given:

- **`reuse`**: no model. With a plan file from the request, record `phase plan --status done --plan <path>`. With a plan already in the run directory, record `phase plan --status done`
- **`import`**: spawn the `planner` phase subagent with the model from `next` (`sonnet`) on `skills/sdlc/esp-plan/SKILL.md` with `--import <path> --interactive off`, where `<path>` is the triage `path`. The planner writes the plan into the run directory. Then record `phase plan --status done`
- **`synthesize`** (`--plan-mode skip`): no model. Run `plan.mjs synthesize --run-dir <run-dir> --title <title> --goal <goal> --validation <command>`, with the title and the goal from the request (repeat `--validation` for each gate, `--files <a,b>` when known), then record `phase plan --status done`
- **`generate`**: spawn the `planner` phase subagent (see Phase Subagents in SKILL.md) on `skills/sdlc/esp-plan/SKILL.md` with `--interactive off <request>`. With `escalated_from` in `ship.json`, add the escalation reason and the files already changed as extra context: the plan may reuse that work. The planner writes the plan into the run directory. Then record `phase plan --status done`

## After the Plan

- `phase plan --status done` checks the milestone budget. `milestones.action: halt` runs `ship.mjs halt --key budget`
- In `plan` or `all` mode: run the plan checkpoint (see Interactive Checkpoints in SKILL.md). Feedback runs `esp-plan --amend --interactive off "<feedback>"` in a new planner subagent, then the check again
- A planner that replies `needs-decision` follows Waiting and Open Items in SKILL.md

## Amending

A user message that changes the plan, or feedback at the checkpoint, goes through `esp-plan --amend`: it keeps the completed milestones unchanged. Then run `ship.mjs milestone init` again before the next milestone: it syncs `state.json` with the amended plan and keeps the done milestones.
