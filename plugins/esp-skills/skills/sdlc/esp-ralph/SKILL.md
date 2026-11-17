---
name: esp-ralph
description: Build a ralph loop prompt from a plan, a tracker document or a task, then launch the esp-ralph-loop workflow
argument-hint: "[-y|--yes] [-s|--allow-subagents] [-P|--prompt <file>] [-m|--max-iterations <n>] [-a|--model <alias>] [-e|--effort <level>] [-d|--run-dir <path>] [source]"
disable-model-invocation: true
---

# ESP Ralph

## Overview

Run a long task as a ralph loop: one fresh `esp-iterator` agent per iteration does one unit of work, commits and stops, until the task is complete, blocked or out of iterations. A workflow cannot ask anything, so this skill does the talking: it detects the kind of source, fills the prompt template with what the source and the repository already say, asks only for what is missing, writes `prompt.md` into a run directory for review, then launches the `esp-skills:esp-ralph-loop` saved workflow in the background. While the loop runs, a plain message in this session steers it.

`detect -> build -> review -> launch -> (steer) -> report`

## Arguments

### Definitions

- **`[-y|--yes]`** (optional): Launch without the review step. Always on in a headless session.
- **`[-s|--allow-subagents]`** (optional): Run iterations as `general-purpose` agents, which may spawn subagents, instead of `esp-iterator` agents, which cannot. Defaults to `ralph.allow_subagents` (`false`).
- **`[-P|--prompt <file>]`** (optional): Launch this prompt file as it is: no detection, no building, no review.
- **`[-m|--max-iterations <n>]`** (optional): Most iterations of this launch. Defaults to `ralph.max_iterations` (`25`).
- **`[-a|--model <alias>]`** (optional): Model of every iteration: `opus`, `sonnet`, `haiku` or `fable`. Defaults to the session model.
- **`[-e|--effort <level>]`** (optional): Reasoning effort of every iteration: `low`, `medium`, `high`, `xhigh` or `max`. Defaults to the agent's own.
- **`[-d|--run-dir <path>]`** (optional): Reuse this run, for a relaunch after a stop: its `prompt.md` and `notes.md` carry over. Without it, the skill creates a run under `runs.root`.
- **`[source]`** (required unless `--prompt` or `--run-dir`): A path to an esp-plan plan, a path to a document that tracks its own work (a progress checklist, a task list, a findings document), or a free-text task.

### Values

Arguments: $ARGUMENTS

## Additional Resources

- For the prompt slots and the rules for filling them, see [ralph-prompt-template.md](references/ralph-prompt-template.md): read it in step 4
- For a filled prompt, see [plan-prompt.md](references/examples/plan-prompt.md) (the `plan` preset) and [tracker-prompt.md](references/examples/tracker-prompt.md) (the `tracker` preset): read the one of the detected preset in step 4
- For the generic loop rules the prompt must not repeat, see [esp-iterator.md](../../../agents/esp-iterator.md): read it in step 4
- For the run directory, the notes format and `runs.mjs`, see [run-directory.md](../../../references/run-directory.md): read it when a `runs.mjs` call fails
- For the classes and decision logging, see [decision-policy.md](../../../references/decision-policy.md): read it before logging a decision

## Core Principles

- The prompt holds only what is specific to the task: the generic loop rules live in `esp-iterator.md`, and the iteration status comes from the workflow schema
- Ask only for what the source and the repository leave open
- The prompt lives in the run directory (`<run-dir>/prompt.md`), never in the repository
- The loop runs in the background. This session stays the user's channel to it: it records every correction in `notes.md` and reports the end
- Run every script with Bash, with the literal `"${CLAUDE_PLUGIN_ROOT}/scripts/..."` path and long option names
- Log each decision this session makes with `runs.mjs decision`, when it is made

## Skill-Specific Guidelines

### Configuration

Read the section once at the start:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get ralph
```

If the command exits with code 1 (invalid config), report its error and stop. If `node` is missing, say the skill needs Node 22 and stop.

- `ralph.max_iterations` (default `25`): iterations of one launch, unless `--max-iterations` is given
- `ralph.no_progress_limit` (default `2`): consecutive iterations with no new commit and no progress note before the loop stops
- `ralph.allow_subagents` (default `false`): iterations as `general-purpose` agents, unless `--allow-subagents` is given

### Presets

- **`plan`**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" parse <source>` exits `0`. The unit is one milestone. The tracker is the plan's `## Progress Tracking` checklist when it has one (a context section), otherwise `Done: M<n>` run notes; in-progress marks and milestone notes always go to the run notes, never into the plan, whose milestones allow no other `####` subsection (`plan.mjs parse` must keep passing). The pick rule is the first unchecked milestone whose Depends are checked, the verify commands are the milestone's Validation lines, and the completion is every box checked (plus the pull request, when the plan ends with one)
- **`tracker`**: any other readable document with a checklist (`plan.mjs tasks <source>` returns packages) or one status line per item (`Status:`, `Decision:`, `[ ]`). The units are its items, the tracker is the document itself, and the pick rule, filters and status vocabulary come from how the document marks its items
- **`task`**: free text, or a path that holds neither. Write the task in a few sentences under Source and split it into a short numbered list of units under Unit. Progress goes to the run notes (`Started: <unit>`, `Done: <unit>`)

A path that does not exist is an error, not free text: report it and stop.

### Slot Sources

- **`repo`**: `git rev-parse --show-toplevel`
- **branch** (named in `procedure`): the branch the source names; else the current branch when it is not the default branch; else a new name per `branch.pattern` (`config.mjs get branch`), created by the first iteration with `esp-branch`
- **`verify`**: the unit's own validation lines first, then the package scripts (`package.json` `scripts`, `Makefile`, `pyproject.toml`, `justfile`) and the gate commands `AGENTS.md` names. Per unit, scope them to the tests of the change
- **`commit`**, **`conventions`**: `AGENTS.md`, `CLAUDE.md` and the user's global instructions in context (commit skills, naming rules, files never to edit, local references never to name)
- **`finish`**: the pre-PR checks the repository documents (for example `pnpm check`), then `esp-pr`, when the source or the user expects a pull request
- **`questions`**: the source's own bar when it has one; otherwise the template default

### Steering

While the loop runs, treat every message from the user that is about the loop as a correction for the next iteration:

1. Find the run: the run directory this session launched, or `node "${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs" index --status running --workflow esp-ralph` when it is not known.
2. Record the message, in the user's words: `node "${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs" notes --append "<message>" --from operator --run-dir <run-dir>`.
3. Confirm in one line that the next iteration applies it. The iteration running now does not see it.

A request to stop, pause or cancel is recorded the same way (`Stop the loop: <reason>`): the next iteration ends the loop with `status: blocked`. To stop at once instead, stop the workflow task itself.

## Instructions

1. **Parse arguments**: read each option by its short or long name (`-P` or `--prompt`, `-m` or `--max-iterations`, and so on; `--effort=<level>` works too) and `[source]`. Without `[source]`, `--prompt` or `--run-dir`, ask for the source (headless: report the missing source and stop). Done when the source, or the prompt file or run to reuse, is known.
2. **Load configuration** (see Configuration), and resolve `max_iterations`, `allow_subagents`, `model` and `effort` from the arguments first, then the config. `no_progress_limit` comes from the config only.
3. **Reuse a prompt or a run**:
   - With `--prompt <file>`: check that the file exists, take it as the task file unchanged, and go to step 6 (no build, no review).
   - With `--run-dir <path>` and no `[source]`: read the run (`runs.mjs get --run-dir <path>`), take `<path>/prompt.md` as the task file (report and stop when it is missing), and go to step 6. Its `notes.md` carries over, so the next iteration resumes where the last one stopped.
   - Otherwise continue with step 4. Done when the task file is known, or the build is next.
4. **Detect and build**: pick the preset (see Presets), read the template, the example of the preset, `esp-iterator.md`, the source in full, `AGENTS.md`, `CLAUDE.md` and the package scripts. Fill every slot (see Slot Sources), following the filling rules at the top of the template. For each slot still empty, ask with `AskUserQuestion`: at most four questions in one call, each with a recommended default first. Headless, use the slot's template default, or your best reading of the source when it has none, and keep each choice to log as a decision in step 5.1. Done when every slot has content and nothing in the draft repeats a rule of `esp-iterator.md`.
5. **Review**:
   1. Create the run, or reuse `--run-dir`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs" create <slug> --workflow esp-ralph --title "<title>" --repo <repo> --branch <branch>` (it prints `run_dir`). Log the headless choices of step 4 as decisions.
   2. Write the prompt to `<run-dir>/prompt.md` with the Write tool. Check that it holds no `{{`, no `<!--` and no `ralph_complete`, `ralph_failed` or `promise` block.
   3. Without `--yes` and in an interactive session, show the path and the summary (see Templates), then ask with `AskUserQuestion`: **Launch** (recommended), **Edit** or **Cancel**. On Edit, apply the user's change to `prompt.md` (or wait for them to edit it), show the summary again and ask again. On Cancel, run `runs.mjs update --status canceled --run-dir <run-dir>`, log the decision, and stop.
   4. Done when the user chose Launch, or `--yes` or a headless session skipped the question.
6. **Launch**:
   1. With a reused run, set it running again: `runs.mjs update --status running --run-dir <run-dir>`. With `--prompt` and no run, create one as in step 5.1, taking the title and the repository from the prompt's `# Ralph Task:` and `**Repository**:` lines (else the file name and the current repository), then copy the prompt file unchanged to `<run-dir>/prompt.md` and take that copy as the task file, so `--run-dir` can resume the run.
   2. Log the launch as a decision (`phase: launch`, the preset, `max_iterations`, the agent type, `refs`: the prompt path).
   3. Call the Workflow tool with `name: "esp-skills:esp-ralph-loop"` and `args: { task: "<prompt path>", run_dir: "<run-dir>", max_iterations: <n>, no_progress_limit: <n>, allow_subagents: <bool> }`, adding `plugin_root: "${CLAUDE_PLUGIN_ROOT}"` (the expanded absolute path) with `allow_subagents`, and `model` and `effort` only when set. It returns at once; the loop runs in the background.
   4. Tell the user it started, with the run directory and how to steer and stop it (see Output Guidance). Done when the Workflow call returned a task ID.
7. **Steer**: until the workflow ends, record each user message about the loop (see Steering).
8. **Report**: when the workflow's notification arrives, read its return value (`reason`, `blocker`, `run_dir`, `iterations`, `commits`):
   1. Set the run status from the end reason with `runs.mjs update --status <status> --run-dir <run-dir>`: `done` on `complete`, `blocked` on `blocked`, `halted` on `max_iterations`, `no_progress` or `agent_failures`, and `failed` when the workflow itself failed (no return value, its error as the blocker). The last iteration may have set it already; setting it again is harmless.
   2. Log the end reason as a decision (`phase: report`, `source: policy`, the blocker in `rationale` when there is one).
   3. Report the end (see Output Guidance). Done when the run status matches the end reason and the report is sent.

## Output Guidance

Reply in short markdown for the user.

- **Launch**: one line with the run directory and the iteration limit, then two lines: "Steer: send a message here, the next iteration applies it." and "Stop: ask me to stop the loop (it ends at the next iteration), or stop the workflow task to end it at once."
- **Report**: the end reason in plain words (complete, blocked, out of iterations, no progress, agent failures), the number of iterations, one bullet per iteration with its summary and short commit SHAs, the blocker when there is one, and the relaunch command when the work is not done: `/esp-skills:esp-ralph --run-dir <run-dir>`.
- **Cancel or error**: one line with what stopped the skill and the fix to try.

## Templates

The review summary, five lines:

```markdown
**Prompt**: `~/.esp-skills/runs/2026-11-16-csv-export/prompt.md`

- **Source**: `plan.md` (preset `plan`, 4 milestones, 1 done)
- **Unit**: one milestone, the first unchecked one whose Depends are checked
- **Tracker**: Progress Tracking checklist, Notes per milestone
- **Verify**: each milestone's Validation lines, related tests only
- **Finish**: `pnpm check`, then `esp-pr`; complete when every box is checked and the PR is open
```

The end report:

```markdown
**Ralph loop complete** after 4 iterations (`~/.esp-skills/runs/2026-11-16-csv-export`)

- 1: M1 done, export service (`a1b2c3d`)
- 2: M2 done, CSV writer with escaping (`d4e5f6a`)
- 3: M3 done, export button and download (`b7c8d9e`)
- 4: finish step, PR https://github.com/o/reports-app/pull/88 opened
```
