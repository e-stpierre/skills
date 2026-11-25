# Units

Each unit of the graph runs one way, picked by its kind. `next` returns the action of the next unit to start, with everything the unit needs: `unit`, `kind`, `title`, `repo`, `project_dir` (the checkout), `run_dir` (`<run-dir>/units/<id>`), `mode`, `resume`, `args` and `arguments` (the esp-ship arguments as a list and as one quoted string), `invoke` (the full `/esp-skills:esp-ship ...` line) and `start` (the `orchestrate.mjs` command that marks it running).

## Unit Kinds

- **`build`**: a change shipped as a new pull request, or on the existing branch of `settings.branch`. Runs `/esp-skills:esp-ship` with the unit plan (`--plan-mode skip` and `plans/<id>.md` for `plan: master`) or with its brief (`plan: self`)
- **`adopt`**: an open pull request taken over. Runs `/esp-skills:esp-ship --pr <url>`: the review wait, the fix rounds and the merge, with no plan and no build
- **`await-pr`**: a pull request someone else opens (a release bot, a teammate). First a wait (`start-wait`, `wait-for.mjs pr`, see housekeeping.md); once `wait record` keeps the pull request it found, the unit is `pending` again and `next` adopts it like an `adopt` unit
- **`check`**: no pull request. A wait only (`start-wait`, `wait-for.mjs command`): it ends `done` when the command exits 0

Every esp-ship unit gets `--run-dir <run-dir>/units/<id> --parent-run <run-dir> --project-dir <repo_dir> --interactive off` (`--interactive all` for an inline unit under `-i all`), and the unit settings (`--merge-policy`, `--checks`, `--review`, `--max-rounds`, `--reviewers`, `--draft`, `--branch`). Pass the `arguments` of the action as they are.

## Starting a Unit

Before the unit runs, run its `start` command: `orchestrate.mjs unit start <id> --mode subagent|inline`. It refuses a unit that is not ready, a unit with no checkout, and a second running unit in the same checkout. Never start a unit `next` did not return.

### Subagent Mode

Spawn the unit with the Agent tool, `subagent_type: general-purpose`, in the background (`run_in_background: true`), then run `next` again without waiting. Keep the agent ID of each unit while the session lasts, to continue it (see Needs Decision). The prompt is self-contained:

```markdown
You run one unit of an esp-orchestrate run: <title> (<kind>) in <repo>.
Invoke /esp-skills:esp-ship with the Skill tool, with exactly these arguments:
<arguments>
The unit's repository is <project_dir>: name it in every command (--project-dir, git -C <project_dir>), because you start in
another directory. You are a subagent: never ask the user, return any question in your reply (interactive mode off). Wait in
the foreground, at most 10 minutes per command, when the skill says to wait in the background.
<brief and operator notes>
End with the esp-ship reply (Status, Commit, Summary, ... lines), and nothing after it.
```

`<brief and operator notes>` holds the unit `brief` for a `build` unit and the user messages that concern the unit. Leave it out when there are none.

### Inline Mode

Run the unit in this session: invoke `/esp-skills:esp-ship` with the Skill tool and the `arguments` of the action, and follow it to its reply. The loop waits for it: nothing else starts until the unit replies. Under `-i all`, esp-ship runs with `--interactive all` and asks its own checkpoints, including the one before the merge.

`next` picks inline (`mode_reason` says why) when the unit mode is `inline`, with `-i all`, when `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is below `3` (a unit subagent needs three levels: the unit, its builder or verifier, and their relay), or for the last unit left.

### Resumed Units

After `orchestrate.mjs resume`, `next` returns the spawn action of each unit that was running, with `resume: true` and `--resume` in its arguments, in the same unit run directory. Start it with its `start` command as any other unit. A unit stopped before its esp-ship run initialized starts over with its full arguments (`resume: false`).

## Unit Replies

A unit ends with the esp-ship reply: its own reply in inline mode, the subagent's report in subagent mode. Read the facts from the unit run, which holds them even when the report is missing: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ship.mjs" outcome --run-dir <run-dir>/units/<id>` (read-only) gives `status`, `pr`, `summary`, `blockers` and `outputs.merge`. Then record the unit:

- **`Status: done`**, outcome `merged`: `orchestrate.mjs unit done <id> --status merged --pr <url> --merge-commit <sha>`. The merge commit comes from `gh pr view <url> --json mergeCommit --jq .mergeCommit.oid`
- **`Status: done`**, outcome `done` (merge policy `none`, or a pull request left open on purpose): `unit done <id> --status done --pr <url>` when there is a pull request
- **`Status: needs-decision`**: see Needs Decision
- **`Status: halted`**: `unit failed <id> --status halted --reason <summary>`
- **`Status: failed`**: `unit failed <id> --reason <summary>`
- **No `Status:` line**: read the outcome. A finished esp-ship run (`merged`, `done`) is recorded as above; anything else is `unit failed <id> --reason "no status line"`

A stopped unit marks its pending dependents `blocked` (the command prints them in `blocked`). Then run `next` again.

## Needs Decision

esp-ship replies `needs-decision` for an open question (a B-Decide item with no default, a B-Scope item that cannot be deferred) or for an `awaiting-human` stop (open review items, a merge blocked by a condition, a `human` merge policy still unmerged at its deadline). Its `Question:` line, or the outcome `blockers`, say which.

- **`-i off`**: a critical stop. `unit blocked <id> --reason <summary> --question <question or first blocker>`
- **`-i plan` or `all`, with a question**: ask it with `AskUserQuestion` (the options from the `Question:` line, the recommended one first), log the answer with `runs.mjs decision` (`source: operator`, the unit ID in `refs`), and append it to the unit run: `runs.mjs notes --append <answer> --from operator --run-dir <run-dir>/units/<id>`. Then continue the unit, which stays `running`:
  - Subagent mode: send the answer with SendMessage to the unit's agent ID, asking it to resume with `/esp-skills:esp-ship --resume --run-dir <run-dir>/units/<id> --parent-run <run-dir> --project-dir <repo_dir> --interactive off`. When the send fails or the agent ID is lost, spawn a fresh unit subagent with those arguments and the answer in its prompt
  - Inline mode: invoke `/esp-skills:esp-ship` with those arguments (`--interactive all` under `-i all`) in this session
- **`-i plan` or `all`, with only blockers** (no question): the unit waits for a person outside the run. `unit blocked <id> --reason <first blocker>`; the run resumes it with `--resume` once the blocker is gone

A unit's `awaiting-human` or `halted` status blocks its dependents. `/esp-skills:esp-orchestrate --resume --run-dir <run-dir>` sends it again: `orchestrate.mjs resume` turns an esp-ship unit back to `running` with `--resume`, restarts a wait with a new deadline, and makes its blocked dependents `pending`.

## Critical Stops

The unit's esp-ship run halts on the stop conditions of `ship.halt_on` and replies `halted` or `needs-decision`. This session stops a unit itself (`unit blocked`, or `unit failed --status halted`) when its reply or its outcome names:

- A security or data-loss finding still open after the unit's fix rounds
- A destructive git operation it would need: a force-push outside its task branch, deleting a remote branch the run did not create, rewriting shared history
- An architecture change or a large refactor that the master plan does not contain

Log each critical stop with `runs.mjs decision` (`source: policy`, `risk: high`, the unit ID in `refs`). A merge that triggers a publish or a release is part of the plan, not a stop.
