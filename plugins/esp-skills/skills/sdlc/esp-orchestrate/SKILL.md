---
name: esp-orchestrate
description: Take a change that spans several pull requests or repositories to merged code. Use to run a task graph of esp-ship units, waits and local cleanup from one request.
argument-hint: "[-u|--resume] [-H|--no-housekeeping] [-W|--no-write-back] [-i|--interactive <mode>] [-d|--run-dir <path>] [-U|--unit-mode <mode>] [-l|--max-parallel <n>] [-g|--merge-policy <policy>] [-m|--max-rounds <n>] [context]"
disable-model-invocation: true
---

# ESP Orchestrate

## Overview

Take one request that needs several pull requests, possibly in several repositories, to merged code. Intake writes a master plan and a task graph of units: `build` (a new change), `adopt` (an open pull request), `await-pr` (a pull request someone else opens) and `check` (a command polled until it succeeds, such as a release run). Each pull request unit runs through `esp-ship`, the waits run as background scripts, the local checkouts are tidied after each merge, and the report lists what landed. `scripts/orchestrate.mjs` decides what runs next from the files of the run directory, so an interrupted run resumes where it stopped.

`preflight -> intake -> graph + master plan -> [approve] -> schedule units -> (esp-ship unit | adopt PR | await PR | check) per unit -> housekeeping -> write-back -> summary`

## Arguments

### Definitions

- **`[-u|--resume]`** (optional): Continue the run in `--run-dir` from `orchestrate.json`, with the settings recorded at its start. Units that were running resume their esp-ship run, started waits keep their deadline, and units awaiting a human go again. Fails when the run has no `orchestrate.json`.
- **`[-H|--no-housekeeping]`** (optional): Skip the git housekeeping after each merge (fast-forward the base, delete the merged branch, remove the run worktrees, rebase later branches). Defaults to `orchestrate.housekeeping` (`true`).
- **`[-W|--no-write-back]`** (optional): Skip the write-back unit that ticks the source task document. Defaults to `orchestrate.write_back` (`true`).
- **`[-i|--interactive <mode>]`** (optional): `off`, `plan` or `all`. `plan` approves the graph and the master plan, then runs on its own. `all` also stops before each unit and runs every unit inline, so esp-ship asks its own checkpoints (before each merge included). Defaults to `defaults.interactive` (`off`). Headless sessions always use `off`.
- **`[-d|--run-dir <path>]`** (optional): Run directory to use or to resume. A run that already holds a plan (from esp-plan) becomes the parent run, with that plan as the master plan source. Without it, the skill creates its run under `runs.root`.
- **`[-U|--unit-mode <mode>]`** (optional): `auto`, `subagent` or `inline`. `auto` runs a unit inline with `-i all`, when `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is below `3`, or for the last unit left, else in a background subagent. Defaults to `orchestrate.unit_mode` (`auto`).
- **`[-l|--max-parallel <n>]`** (optional): Units or waits running at once, `1` to `4`. Units of one checkout never run together. Defaults to `orchestrate.max_parallel` (`2`).
- **`[-g|--merge-policy <policy>]`** (optional): Default merge policy of the units: `auto` (esp-merge merges), `human` (wait for a person to merge) or `none` (leave the pull request open). A unit of the graph may set its own. Defaults to `ship.merge_policy` (`auto`).
- **`[-m|--max-rounds <n>]`** (optional): Default pull request fix rounds of each unit. Defaults to `fix-review.max_rounds` (`3`).
- **`[context]`** (required unless resuming, or unless `--run-dir` names a run that already holds a plan): The request: a description, a task document path (numbered steps, `Depends on:` lines, progress checkboxes), a GitHub issue URL or `#<number>`.

### Values

Arguments: $ARGUMENTS

## Additional Resources

- For the inputs, the master plan, the graph schema, sizing, the merge-policy rule and the write-back unit, see [intake.md](references/intake.md): read it in step 5
- For the unit kinds, the unit subagent prompt, inline units, mapping a unit reply and `needs-decision`, see [units.md](references/units.md): read it before the first `spawn-unit` or `run-unit-inline` action
- For repository resolution and preflight, the waits and the housekeeping steps, see [housekeeping.md](references/housekeeping.md): read it in step 6, and before the first `start-wait` or `housekeep` action
- For the classes, the stop conditions and the reply format (Replies), see [decision-policy.md](../../../references/decision-policy.md): read it before asking, stopping a unit, or acting on the first unit reply
- For `summary.md`, see [summary-template.md](../../../references/summary-template.md): read it in step 9
- For the run directory files and commands, see [run-directory.md](../../../references/run-directory.md): read it when a `runs.mjs` call fails

## Core Principles

- This session schedules, it does not build. Every pull request unit runs through `/esp-skills:esp-ship`, in a background subagent or inline. This session keeps only unit replies and wait results; details stay in the run directory
- `orchestrate.mjs next` decides the single next action. Every state change goes through `orchestrate.mjs` (the only writer of `orchestrate.json` and `graph.json`) and `runs.mjs` (`run.json`, `decisions.jsonl`, `notes.md`)
- Run every script with Bash, with the literal `"${CLAUDE_PLUGIN_ROOT}/scripts/..."` path and long option names. Every `orchestrate.mjs` command takes `--run-dir <run-dir>`
- Name each unit's repository explicitly in every prompt and command (`--project-dir`, `git -C <dir>`): a subagent starts in this session's directory, not in the unit's checkout
- A stopped unit blocks its dependents only: independent units still finish, and the run ends `partial`. Never revert a merged unit
- Never force-push, never delete a remote branch, and never touch a dirty checkout: housekeeping reports it and moves on
- Log each decision this session makes with `runs.mjs decision`, when it is made

## Skill-Specific Guidelines

### Configuration

Read the sections once at the start, from the repository the request starts in (`<repo-root>`: the git root of the current directory). On a resume, or once `init` has run, add `--run-dir <run-dir>` so the frozen snapshot is read:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get orchestrate --project-dir <repo-root>
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get defaults --project-dir <repo-root>
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get worktrees --project-dir <repo-root>
```

If a command exits with code 1 (invalid config), report its error and stop. `orchestrate.mjs init` applies the `orchestrate` keys itself (`unit_mode`, `max_parallel`, `housekeeping`, `write_back`, `wait`), and the unit defaults from `ship.merge_policy` and `fix-review.max_rounds`. This session reads directly `orchestrate.repos` (known checkouts), `defaults.interactive` and `worktrees.root` (where a missing repository is cloned). `init` freezes the config to `<run-dir>/config.snapshot.json`: every unit's esp-ship run starts from it (`--parent-run`), with the project config of the unit's repository over it.

### Run State

`scripts/orchestrate.mjs` owns `<run-dir>/orchestrate.json` (settings, phase, approval, one entry per unit, the waits) and `<run-dir>/graph.json` (the units, written once by intake). `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs" --help` lists every command and option:

- **`init`**, **`show`**: create the state, print it with the graph
- **`intake --graph <file> [--record]`**: validate the graph and resolve the repositories; `--record` writes `graph.json` (see intake.md)
- **`approve`**: record the plan approval
- **`next`**: the next action (see Execution Loop)
- **`unit start|done|failed|blocked <id>`**: the transitions of an esp-ship unit (see units.md)
- **`wait start|record <id>`**: the wait of a `check` or `await-pr` unit (see housekeeping.md)
- **`housekeep --unit <id> --result <json|file>`**: record the housekeeping of a merged unit
- **`resume`**: make the run resumable from disk; run it only at the start of a resumed session, when no unit subagent of this run is alive
- **`outcome`**: the run status (`merged`, `partial`, `awaiting-human`, `halted`, `failed`, or `running` while a unit is not terminal), one entry per unit, the dirty checkouts and the resume command

Unit statuses: `pending`, `running`, `waiting`, `merged`, `done`, `failed`, `halted`, `blocked`, `awaiting-human`. A unit is ready when every dependency is `merged` or `done`.

### Execution Loop

Run `orchestrate.mjs next` and act on `action`, then run `next` again, until it returns `idle` or `finish`:

- **`intake`**: no graph yet. Run the intake (Instructions step 5)
- **`checkpoint`**: see Interactive Checkpoints. `kind: unresolved-repo` (a ready unit with no known checkout) is not a question: resolve the checkout as in housekeeping.md when every unit is still pending and record the graph again, else run `unit failed <unit> --reason <reason>`
- **`spawn-unit`**: run its `start` command (`orchestrate.mjs unit start <unit> --mode subagent`), then spawn the unit subagent in the background with the prompt of units.md and the `arguments` of the action. Do not wait for it: run `next` again
- **`run-unit-inline`**: run its `start` command, then invoke `/esp-skills:esp-ship` with the Skill tool and the `arguments` of the action, in this session. Its reply is the unit reply (see units.md)
- **`start-wait`**: run `orchestrate.mjs wait start <unit>`, then its `command` in the background (see Waiting). `restart: true` restarts an interrupted wait with the same state file
- **`housekeep`**: run its `command`, or record its `skip`, then record the result with `orchestrate.mjs housekeep` (see housekeeping.md)
- **`idle`**: units or waits are running. End the turn: the next unit reply or wait exit wakes this session. When `running` and `waiting` are both empty, nothing can start: report the state from `show` and stop with `status: failed`
- **`finish`**: every unit is terminal (`status` is the run status). Go to the outcome

A unit reply or a wait exit can arrive while this session is in the middle of the loop: record it first (`unit done|failed|blocked`, or `wait record`), then run `next`.

A message the user sends while the run is going is read at the next action. Record it with `runs.mjs notes --append <text> --from operator --run-dir <run-dir>`, and pass it to the next unit it concerns, in its prompt (and with `runs.mjs notes --append <text> --from operator --run-dir <unit-run-dir>` for a running unit). A message that says to stop: start nothing new, let the running units finish, and stop each pending unit with `unit blocked <id> --reason "Stopped by the operator"`.

### Waiting

Waits cost no tokens: `check` and `await-pr` units, and every running unit subagent, run in the background, and this session ends its turn on `idle`. The exit notification of a wait, or the reply of a unit, wakes it. How to run, record and restart a wait: housekeeping.md (Waits).

### Interactive Checkpoints

Only in `plan` or `all` mode (step 1 resolves the mode to `off` when headless). This session asks with `AskUserQuestion`, the recommended option first, and logs each answer with `runs.mjs decision` (`source: operator`):

- **`approve-plan`** (`plan`, `all`): show the units (`id`, `kind`, `repo`, `depends_on`, `plan`, `merge`) and the master plan at `plan_path`. Approve runs `orchestrate.mjs approve`. Feedback changes the master plan and the graph file, then `intake --graph <file> --record` again (allowed while every unit is pending) and the checkpoint comes back. Stop leaves the run in the approve phase, resumable
- **`before-unit`** (`all`): show the unit (`unit`, `title`) and its action in `then`. Go acts on `then` directly (its `start` command, then the unit): `next` returns the same checkpoint until the unit starts. Hold runs `unit blocked <unit> --reason "Held at the checkpoint"`
- **Before each merge** (`all`): esp-ship asks it itself, because every unit runs inline with `--interactive all`
- **A unit that replies `needs-decision`** (`plan`, `all`): ask its question here, then continue the unit with the answer (see units.md). In `off` mode, it is a critical stop

### Critical Stops

Unattended, this session and every unit decide, log and continue, except on:

- A B-Decide item with no default policy, or a B-Scope item that cannot be deferred (the unit replies `needs-decision`)
- A security or data-loss finding still open after the unit's fix rounds
- A destructive git operation: a force-push outside a task branch, deleting a remote branch the run did not create, rewriting shared history
- An architecture change or a large refactor that the master plan does not contain

The unit's esp-ship run halts on its own stop conditions (`ship.halt_on`); this session stops a unit itself when its reply or its outcome names one of the stops above. A critical stop ends the unit (`unit blocked`, or `unit failed --status halted` for a halt) and blocks its dependents; independent units still finish. Log each one with `runs.mjs decision` (`source: policy`, `risk: high`, the unit ID in `refs`). Merging a pull request that triggers a publish or a release is not a stop: the plan contains it.

## Instructions

1. **Parse arguments**: read each option by its short or long name (`-l 3` or `--max-parallel 3`, `--unit-mode=inline` too), and the trailing `[context]`. Resolve the interactive mode: `-i`/`--interactive`, else `defaults.interactive`, `off` when headless. `--resume` without `--run-dir`, `--resume` on a run without `orchestrate.json`, an unknown `--interactive`, `--unit-mode` or `--merge-policy` value, a `--max-parallel` outside `1` to `4`, a `--max-rounds` that is not a positive integer, or no `[context]` on a new run whose `--run-dir` holds no plan (`runs.mjs plan --run-dir <path>` prints `version` `0`) is a usage error: report it and stop.
2. **Load configuration** (see Configuration). Done when the three sections are read.
3. **Preflight the session**: `<repo-root>` is a git checkout (`git rev-parse --show-toplevel`) and `gh auth status` succeeds. Otherwise report it and stop with `status: failed`. The unit repositories are checked in step 6, once the graph names them.
4. **Resolve the run**: with `--resume`, run `orchestrate.mjs resume`, tell the user which units resume and which waits restart, and go to step 7. With `--run-dir`, use it (`runs.mjs create --run-dir <path> --workflow esp-orchestrate --project-dir <repo-root>` is a no-op on an existing run). Otherwise `runs.mjs create <slug> --title <request title> --workflow esp-orchestrate --repo <owner/name of repo-root> --project-dir <repo-root>`. Write the request as given to `<run-dir>/request.md`. Without `[context]`, the request is the title of the run's plan (the first level-1 heading of the `path` that `runs.mjs plan --run-dir <run-dir>` prints): write it to `request.md` and pass it as `--request`. Then `orchestrate.mjs init --request <request text> --project-dir <repo-root> --interactive <mode>`, with the long form of each other flag that was given (`--unit-mode`, `--max-parallel`, `--merge-policy`, `--max-rounds`, `--no-housekeeping`, `--no-write-back`). Done when `init` prints the state with `phase: intake`.
5. **Intake** (see [intake.md](references/intake.md)): write the master plan `<run-dir>/plan.md`, the unit plans `<run-dir>/plans/<id>.md` of the small `build` units, and the graph file `<run-dir>/graph.draft.json`, then validate it with `orchestrate.mjs intake --graph <run-dir>/graph.draft.json` (no `--record`). Fix every error it lists. Done when it exits 0.
6. **Repositories and record** (see [housekeeping.md](references/housekeeping.md)): resolve every repository in `unresolved` (ask in `plan` or `all` mode, else clone under `worktrees.root`) and put its `repo_dir` in the graph file, then preflight each checkout. Run `orchestrate.mjs intake --graph <run-dir>/graph.draft.json --record`. Done when it prints `recorded: true` with an empty `unresolved` list, and the decisions of step 5 are logged.
7. **Loop**: run `orchestrate.mjs next` and act on `action` (see Execution Loop, Interactive Checkpoints and [units.md](references/units.md)), recording every unit reply and wait result as it arrives. Done when `next` returns `finish`.
8. **Outcome**: `orchestrate.mjs outcome`. Done when it prints a `status` other than `running`.
9. **Summary and run status**: write `<run-dir>/summary.md` per the summary template and its esp-orchestrate section (`workflow: esp-orchestrate`, `status` is the outcome status, `pr: null`), and set `runs.mjs update --status` to the outcome status. Done when `runs.mjs check <run-dir>/summary.md` passes and `run.json` has the status.
10. **Report** (see Output Guidance), ending with the reply.

## Output Guidance

A short report with one line per unit, then the reply of decision-policy.md (Replies), built from the outcome:

```markdown
### Orchestrate: Switch the app to the shared presets (partial)

- **Graph**: 5 units in 3 repositories, approved; 2 units at a time
- **lib-presets** (adopt, acme/lib): merged https://github.com/acme/lib/pull/12 (squash, 1a2b3c4)
- **lib-version** (await-pr, acme/lib): merged https://github.com/acme/lib/pull/13 (5d6e7f8)
- **lib-release** (check, acme/lib): done, packages at 0.1.0 after 6 polls
- **app-presets** (build, acme/app): awaiting-human, a review comment asks to rename a public export (B-Scope) on https://github.com/acme/app/pull/40
- **write-back** (build, acme/docs): blocked by app-presets
- **Housekeeping**: acme/lib on main, 2 branches deleted; acme/app left alone (dirty: src/theme.ts)
- **Summary**: ~/.esp-skills/runs/2026-11-24-shared-presets/summary.md
- **Next**: /esp-skills:esp-orchestrate --resume --run-dir ~/.esp-skills/runs/2026-11-24-shared-presets
```

```markdown
Status: needs-decision
Summary: 3 of 5 units landed in acme/lib; app-presets waits for a scope decision on its pull request, write-back is blocked behind it.
Blockers: app-presets: rename the public export setTheme to applyPresets? (https://github.com/acme/app/pull/40)
```

The reply status comes from the outcome status: `merged` is `done`, `partial` and `awaiting-human` are `needs-decision` when a unit awaits a human (each one in `Blockers:`) and `failed` otherwise, `halted` and `failed` stay as they are. For any run that did not land every unit, name the stopped units with their reasons, the pull requests left open, and the resume command from the outcome (`/esp-skills:esp-orchestrate --resume --run-dir <run-dir>`).
