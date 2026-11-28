---
name: esp-ship
description: Ship a task to a merged pull request, inline or as verified milestones. Use to take a task, an issue or a plan to a merged PR, to adopt an open PR through its review fixes and merge, or to ship one unit of a multi-PR change.
argument-hint: "[-u|--resume] [-w|--worktree] [-b|--branch <name>] [-P|--no-pr] [-M|--no-merge] [-D|--draft] [-l|--parallel] [-t|--track <track>] [-L|--plan-mode <mode>] [-R|--review <mode>] [-a|--model <model>] [-m|--max-rounds <n>] [-r|--reviewers <name>...] [-i|--interactive <mode>] [-d|--run-dir <path>] [-p|--pr <url>] [-g|--merge-policy <policy>] [-c|--checks <mode>] [-T|--parent-run <path>] [-C|--project-dir <path>] [context]"
---

# ESP Ship

## Overview

Take any task (a one-line fix, a feature prompt, a GitHub issue, a plan from `esp-plan`) to a merged pull request. Triage picks the track: inline (this session, one commit) or orchestrated (a plan, then one verified commit per milestone and an internal review). Both tracks share the pull request tail. `scripts/ship.mjs` decides what runs next and keeps the state in the run directory, so an interrupted run resumes where it stopped.

`preflight -> triage -> [plan] -> branch -> implement (inline) or build (milestones) -> [internal review <-> fix] -> base sync -> PR -> [wait (reviews + checks) <-> fix-review] -> refresh body -> merge -> summary`

## Arguments

### Definitions

- **`[-u|--resume]`** (optional): Continue the run in `--run-dir` from `ship.json`, with the flags recorded at its start. Lifts an `awaiting-human` stop. `--model` and `--parallel` given with it replace the recorded ones. Fails when the run has no `ship.json`.
- **`[-w|--worktree]`** (optional): Work in a task worktree under `worktrees.root`, so the current checkout stays untouched. Defaults to `ship.worktree` (`false`). A dirty working tree also runs in a task worktree, per `ship.dirty_tree` (`worktree`).
- **`[-b|--branch <name>]`** (optional): Work on this branch: checked out when it exists locally, tracked when it exists on `origin`, else created from `origin/<base>`. Defaults to the current branch when it is not the base or the default branch and the working tree is clean (after the open pull request check, see [workspace.md](references/workspace.md)). Otherwise a new branch named per `branch.pattern`, in a task worktree when the tree is dirty or with `--worktree`.
- **`[-P|--no-pr]`** (optional): Stop after the last commit and the internal review: no push, no pull request.
- **`[-M|--no-merge]`** (optional): Stop after the pull request review fixes, with the pull request left open.
- **`[-D|--draft]`** (optional): Open the pull request as a draft. Defaults to `pr.draft` (`false`). The pull request stays as opened: esp-ship never marks it ready, so a draft ends the task before the merge (esp-merge never merges a draft), with `awaiting-human` and the pull request left open.
- **`[-l|--parallel]`** (optional): Build milestones whose dependencies are done and whose files do not overlap at the same time, each in its own worktree, even when `ship.parallel` would not. Without the flag, `ship.parallel` decides (`auto`: on when the plan has a batch of two or more such milestones and `worktrees.root` is usable). Recorded in `ship.json`, so a resume keeps it. In a harness without parallel subagents, the milestones of a batch are built one after another in the main tree, with the same gates (see [milestones.md](references/milestones.md)).
- **`[-t|--track <track>]`** (optional): `inline` or `orchestrated`. Pins the track instead of letting triage pick it.
- **`[-L|--plan-mode <mode>]`** (optional): `auto`, `skip` or `always`. `skip` uses no planning model: a plan file is reused, a task list imported, a small request runs inline, and a larger one gets a synthesized one-milestone plan. `always` generates a plan even for a small prompt. Defaults to `ship.plan_mode` (`auto`).
- **`[-R|--review <mode>]`** (optional): `auto`, `internal`, `pr`, `both` or `none`. `internal` keeps only the internal review, `pr` only the bot review rounds, `none` drops both (the merge still needs green checks). `auto` keeps the bot review and decides the internal review after the build from the real diff (see review.md). Defaults to `ship.review_mode` (`auto`).
- **`[-a|--model <model>]`** (optional): Builder model for every milestone: a tier (`low`, `medium` or `high`, resolved through `defaults.models.builder.<tier>`), a Claude Code alias (`opus`, `sonnet`, `haiku` or `fable`) or a harness model name (`gpt-5.5-codex`), see [model-selection.md](../../../references/model-selection.md). Overrides the complexity-based choice. The verifier keeps its role model. Recorded in `ship.json`, so a resume keeps it.
- **`[-m|--max-rounds <n>]`** (optional): Pull request fix rounds. Defaults to `fix-review.max_rounds` (`3`).
- **`[-r|--reviewers <name>...]`** (optional): Reviewer names from `fix-review.wait.reviewers` (`claude`, `codex`) or GitHub logins, repeated (`-r claude -r codex`) or comma-separated. Defaults to `fix-review.wait.default_reviewers`.
- **`[-i|--interactive <mode>]`** (optional): `off`, `plan` or `all`. `plan` approves the plan (or the inline approach), then runs on its own. `all` also stops at the internal review findings, before and after each pull request fix round, and before the merge. Defaults to `defaults.interactive` (`off`). Non-interactive sessions and subagents always use `off`.
- **`[-d|--run-dir <path>]`** (optional): Run directory to use or to resume. Without it, the skill creates its run under `runs.root`. The config is frozen in `ship.json` on the first call.
- **`[-p|--pr <url>]`** (optional): Adopt an open pull request (`https://<host>/<owner>/<repo>/pull/<n>`) instead of starting from a task: no triage, the inline track, its head branch checked out, then the review wait, the fix rounds and the merge. Context, implement and the pull request phase are skipped. Cannot be combined with `--no-pr` or `--track orchestrated`.
- **`[-g|--merge-policy <policy>]`** (optional): Who merges the pull request: `auto` (esp-merge merges it), `human` (wait for a person to merge it, up to `merge.human_wait_minutes`) or `none` (skip the merge phase, with the pull request left open). Defaults to `ship.merge_policy` (`auto`).
- **`[-c|--checks <mode>]`** (optional): `required` or `none-expected`. `none-expected` is for a pull request that runs no checks (for example one opened with `GITHUB_TOKEN`): the review wait and the merge do not wait for checks to register, while checks that do exist still block. Logged as a policy decision. Defaults to `required`.
- **`[-T|--parent-run <path>]`** (optional): Run directory of a parent run (an orchestrating run that ships several units). Links both `run.json` files, and freezes the config from the parent `config.snapshot.json` with this repository's project config over it.
- **`[-C|--project-dir <path>]`** (optional): Repository to ship in, when it is not the current one (for example a unit in a sibling repository). The preflight, the config, the run and every phase use it. Defaults to the git root of the current directory.
- **`[context]`** (required unless resuming, adopting with `--pr`, or unless `--run-dir` names a run that already holds a plan): The task: a description, a GitHub issue URL or `#<number>`, or a path to a file that describes it (a plan, a task list, a design document). Without it, a run started by `esp-plan` ships its plan.

### Values

Arguments: $ARGUMENTS

If the line above holds no arguments or an unreplaced placeholder, read them from the message that invoked this skill.

## Additional Resources

- For triage (the track and the plan source), see [triage.md](references/triage.md): read it in step 5
- Read each phase reference when `next` first reaches its phase (see Phase Map):
  - For the plan phase, see [plan.md](references/plan.md)
  - For the inline track (context and implement), see [inline.md](references/inline.md)
  - For the milestone loop, see [milestones.md](references/milestones.md)
  - For the internal review loop, see [review.md](references/review.md)
  - For the pull request, the review wait, the fix rounds and the merge, see [pr-tail.md](references/pr-tail.md)
  - For the branch, the worktree and the preflight of the tree, see [workspace.md](references/workspace.md)
  - For the gate commands, the scoped checks and the final gates, see [gates.md](references/gates.md)
- For the classes, the stop conditions, asking outside an interactive session and the reply every subagent ends with (Replies), see [decision-policy.md](../../../references/decision-policy.md): read it before asking, halting, or acting on the first subagent reply
- For the subagent models, see [model-selection.md](../../../references/model-selection.md): read it when `next` gives no model
- For `summary.md`, see [summary-template.md](../../../references/summary-template.md): read it in step 9
- For the run directory commands, see [run-directory.md](../../../references/run-directory.md): read it when a `runs.mjs` call fails

## Core Principles

- This session orchestrates. It runs the inline phases itself and delegates every other phase to a subagent with a fresh context window, keeping only each short reply (without subagents, it runs them in this session, with the same gates, approvals and saved state). Details stay in the run directory
- `ship.mjs next` decides the phase, the model and the loop. Every state change goes through `ship.mjs` and `runs.mjs`, the only writers of `ship.json` (with its step records), `state.json`, `run.json` and `decisions.jsonl`
- Run every script with a shell. Paths are relative to this skill's directory (a reference file's paths are relative to that file). Resolve a path to an absolute one before running a command with it: commands run from the user's repository. A bare script name (`ship.mjs`) or `scripts/<name>` is the plugin's script, `../../../scripts/<name>` from this directory. The scripts take long option names only, and `--reviewers` as one comma-separated value
- The inline track makes one implementation commit. The orchestrated track makes one verified commit per milestone. Review fixes are separate review-fix commits, titled per `commit.style` (`plain`: `Fix review findings: <summary>`, `conventional`: `fix(review): <summary>`)
- A milestone is done only when an independent `esp-verifier` passes it: the builder's own report never counts
- A halted task stays unmerged. Push only the task branch, force-push only after a rebase of the task branch, and respect branch protection
- Log each decision this session makes with `runs.mjs decision`, when it is made

## Skill-Specific Guidelines

### Configuration

Read the sections once at the start, from the repository the task ships in: pass `--project-dir <repo-root>` to each command (`--project-dir` when given, else the git root of the current directory), so the project layer is the one of that repository. When the run directory already exists (`--resume`, or `--run-dir` naming a run started by esp-plan), add `--run-dir <run-dir>` to each command, so a resumed run reads its frozen config:

```bash
node "../../../scripts/config.mjs" get ship --project-dir <repo-root>
node "../../../scripts/config.mjs" get fix-review --project-dir <repo-root>
node "../../../scripts/config.mjs" get pr --project-dir <repo-root>
node "../../../scripts/config.mjs" get defaults --project-dir <repo-root>
```

If a command exits with code 1 (invalid config), report its error and stop. If it cannot run at all (no `node`), stop: the dispatch needs the scripts. `ship.mjs` applies most `ship.*` keys itself (phases, budgets, inline limits) and `pr.draft`; the reference file of each phase names the keys it reads. This session reads directly:

- **`pr.base`** (`null`: the repository default branch) and **`defaults.interactive`**: the base and the interactive mode
- **`ship.halt_on`**: the stop conditions honored (see decision-policy.md)
- **`ship.merge_policy`**: the `--merge-policy` default, applied by `init`
- **`defaults.models.<role>`**: a subagent model, only when `next` gives none (`ship.mjs` resolves the others, see model-selection.md)

`ship.mjs init` freezes the config in the run (`config.snapshot.json`, recorded in `ship.json`), so a resumed run keeps the settings it started with. The phase skills read their own sections (`plan`, `review`, `fix-review`, `merge`, `pr`, `worktrees`) from that snapshot: they get `--run-dir <run-dir>` and pass it to `config.mjs get`, which then uses the snapshot in place of the user and project layers. The branch name comes from the snapshot too (see workspace.md). esp-commit takes no run directory and reads the live `commit` section.

### Task State

`scripts/ship.mjs` owns `<run-dir>/ship.json`, and `ship.mjs milestone <cmd>` owns `<run-dir>/state.json`. Every command takes `--run-dir <path>`. `node "../../../scripts/ship.mjs" --help` lists every command with its options. The ones with rules of their own:

- **`budget`**, **`scope`**, **`gate-failure`**, **`switch-track`**: the inline limits and the move to the orchestrated track (see inline.md)
- **`workspace`**, **`worktree`**: see workspace.md
- **`final-gates`**: see gates.md
- **`base-sync`**: the rebase onto a moved base before the pull request, see pr-tail.md
- **`review-gate`**: see review.md
- **`milestone <cmd>`**: see milestones.md
- **`record <step>`**: the phase skills and the builders record their own step under esp-ship
- **`stop`**, **`halt`**: both print the state as JSON

`next` actions:

- **`run`**: run `phase` (and `sub` for the review loop). Follow the reference file of the phase (see Phase Map). `resumed: true` means the phase started before an interruption: run it again, the phase skills pick up their own state
- **`review-gate`**: run `ship.mjs review-gate`, then `next` again (see review.md)
- **`complete`**: the internal review loop ended. Record `phase review --status done`
- **`halt`**: run `ship.mjs halt` with its `key` and `reason`
- **`stop`**: run `ship.mjs stop` with its `status` and `reason`
- **`finish`**: every phase ended: go to the outcome

### Phase Map

- **`context`, `implement`** (inline track): in this session, see [inline.md](references/inline.md)
- **`plan`** (orchestrated track): see [plan.md](references/plan.md)
- **`branch`**: see [workspace.md](references/workspace.md). With an adopted pull request (`next` gives `pr`), the branch is its head branch (see Adopted Pull Request there)
- **`build`** (orchestrated track): the milestone loop in this session, see [milestones.md](references/milestones.md)
- **`final-gates`** (orchestrated track): the full gates once in this session, see [gates.md](references/gates.md)
- **`review`** with `sub: review` or `sub: review-fix`: see [review.md](references/review.md)
- **`pr`** (it starts with the base sync), **`fix-review`** (each round starts with the `fix-review-wait` step; `checks_grace_seconds` when given goes to the wait), **`merge`** (`merge_policy` picks esp-merge or the human merge wait): see [pr-tail.md](references/pr-tail.md)

### Phase Subagents

Delegate each subagent phase to a subagent with a fresh context window, briefed with the phase prompt below, with the `model` and `effort` from `next` (pass no model when it is `inherit`; model-selection.md maps a value to the harness). Record it with `runs.mjs update --model <role>=<model>[:<effort>]`. Run it in the foreground and wait for its reply.

- In Claude Code, use the `general-purpose` agent type, with its `model` and `effort` parameters.
- Without subagents, follow the phase prompt in this session: read the phase skill and run its Instructions with the same arguments and interactive mode off, then act on its reply exactly as on a subagent reply. The gates, the checkpoints and the step records stay the same.

The prompt is self-contained:

```markdown
You run one phase of an esp-ship task. Read <plugin-root>/skills/<path>/SKILL.md and follow its Instructions as if
invoked with: <arguments>. Paths in that file are relative to its directory.
Work in <cwd>. You are a subagent: return any question in your reply (interactive mode off); wait in the foreground, at most
10 minutes per command, when the skill says to wait in the background.
<extra context>
End with the reply that file's Output Guidance describes (Status, Summary, ... lines), and nothing after it.
```

`<plugin-root>` is this skill's `../../..` resolved to an absolute path. `<arguments>` uses long option names. Every phase skill that takes it also gets `--run-dir <run-dir>`. User messages received since the last phase go in `<extra context>` (see User Messages).

Before spawning a phase, record `phase <name> --status started`. After it returns, act on the `Status:` line of its reply: `done` records `phase <name> --status done`. `halted` runs `ship.mjs stop --status halted --reason <summary>` (the phase logged its Halt decision). `needs-decision` runs `ship.mjs stop --status awaiting-human` with the question as the reason, and `failed` runs `ship.mjs stop --status failed`, unless Waiting and Open Items says otherwise. A subagent whose reply has no `Status:` line counts as `failed` with reason `no status line`. The facts a later step needs (findings, open items, the merge) are in the step the phase skill recorded with `ship.mjs record`, not in the reply.

The milestone builders and verifiers are not phase subagents: this session briefs them with [esp-builder.md](../../../agents/esp-builder.md) and [esp-verifier.md](../../../agents/esp-verifier.md) (see milestones.md).

In Claude Code, they are the `esp-skills:esp-builder` and `esp-skills:esp-verifier` agent types.

### Waiting and Open Items

- A plan that replies `needs-decision` (open questions): in `plan` or `all` mode, ask, log the answers as operator decisions, and run the plan phase again with `--amend` and the answers. In `off` mode, `ship.mjs stop --status awaiting-human`.
- Open pull request review items, or a merge blocked by a condition, end the task with `awaiting-human` and the pull request left open.

### Interactive Checkpoints

Only in `plan` or `all` mode (step 1 resolves the mode to `off` in a non-interactive session or in a subagent). This session does the asking: it asks the user, with the session's question tool if it has one, otherwise in plain text, one question at a time with the recommended answer first. It logs each answer with `runs.mjs decision` (`source: operator`), and passes it to the next subagent in its prompt:

- **After the plan, or after the inline context phase** (`plan`, `all`): approve the plan (title, milestones, risks, open questions) or the approach and the files, or give feedback. Feedback runs the plan again with `--amend`
- **Before each internal fix** (`all`): the findings by class (`outputs.by_class` of the `review-<N>` step in `ship.json`, details in its `outputs.findings_path`). Fix as recommended, or choose for the B items
- **Before each pull request round** (`all`): the review items and failing checks of the round, classified per decision-policy.md and shown by class. Ask for each B-Decide item (its options, the recommended one first) and each B-Scope item (defer, fix now, reject), then pass the answers to the fixer (see Fix Rounds in [pr-tail.md](references/pr-tail.md))
- **After each pull request round** (`all`): the round recap (fixed, rejected, deferred). Continue, or stop with the pull request open
- **Before the merge** (`all`): merge now, or stop with the pull request open

### User Messages

A message the user sends while the task runs is read at the next phase or milestone boundary. Record it with `runs.mjs notes --append <text> --from operator` (add `--milestone <id>` when it concerns one milestone only): every later builder reads it from `notes.md` at the start of its milestone. Pass it also to the next phase subagent in `<extra context>`, or apply it in this session on the inline track. A message that says to stop is `ship.mjs halt --key scope-change` (or `destructive-action` when it names one). A message that changes the plan runs the plan phase again with `--amend` and the message before the next milestone (see Amending in [plan.md](references/plan.md)). On the inline track, a message that widens the task is a `design` escalation (see inline.md).

## Instructions

1. **Parse arguments**: read each option by its short or long name (`-w` or `--worktree`, `-m 2` or `--max-rounds 2`, `--track=inline` too), and the trailing `[context]`. Collect every `-r`/`--reviewers` value into one comma-separated list. Resolve the interactive mode: `-i`/`--interactive`, else `defaults.interactive`, `off` in a non-interactive session or in a subagent. No `[context]` on a new run is fine when `--run-dir` names a run whose plan exists (`runs.mjs plan --run-dir <path>` prints `version` above `0`): the run ships that plan. `--pr` needs no `[context]`. `--resume` without `--run-dir`, `--resume` on a run without `ship.json`, an unknown `--track`, `--plan-mode`, `--review`, `--model`, `--merge-policy` or `--checks` value, `--pr` that is not a pull request URL or that comes with `--no-pr` or `--track orchestrated`, or no `[context]` on a new run without a plan (and without `--pr`) is a usage error: report it and stop.
2. **Load configuration** (see Configuration). Done when the four sections are read.
3. **Preflight**: on the repository the task ships in (`<repo-root>`: `--project-dir`, else the git root of the current directory), a git repository, and `gh auth status` succeeds unless `--no-pr`. With `--pr`, `gh pr view <url> --json state` reports it `OPEN`. A dirty working tree is fine (the branch phase moves the task to a worktree, see [workspace.md](references/workspace.md)), except with `--branch` naming the current branch, or with `ship.dirty_tree: fail`. Otherwise report it and stop with `status: failed`.
4. **Resolve the run**: with `--run-dir`, use it (`runs.mjs create --run-dir <path>` is a no-op on an existing run). Otherwise `runs.mjs create <slug> --title <task title> --workflow esp-ship --repo <owner/name or repo path> --project-dir <repo-root>`, adding `--parent <parent-run>` with `--parent-run`, so the parent lists the run from the start. Resolve the base: with `--pr`, its base branch (`gh pr view <url> --json baseRefName`), else `pr.base`, else the default branch of `<repo-root>`. Done when the run directory exists and the base is named.
5. **Triage** (new runs only, never with `--pr`: the adopted pull request pins the inline track): run `ship.mjs triage` on the request (or, without `[context]`, on the plan of the run) and pick the track and the plan source (see [triage.md](references/triage.md)). Done when `ship.mjs triage --record` has logged the choices. With `nothing_to_do`, skip to step 9 with the triage facts (`result` of `--record`, also in `<run-dir>/triage.json`).
6. **Initialize**: `ship.mjs init --request <request text> --track <track> --base <base> --project-dir <repo-root>`, with `--plan-source <source>` from triage, `--plan-mode` and `--review-mode` when given, and the long form of each other flag that was given (`--no-pr`, `--no-merge`, `--draft`, `--worktree`, `--parallel`, `--model`, `--max-rounds`, `--interactive`, `--reviewers`, `--merge-policy`, `--checks`, `--parent-run`). Without `[context]`, leave `--request` out: `init` takes the plan title. With `--pr`, run `ship.mjs init --pr <url> --base <base> --project-dir <repo-root>` with the other flags and no `--track` or `--plan-source`: the request defaults to `Adopt <url>`. For a resume, run `ship.mjs init --resume` without `--request`, adding `--model` and `--parallel` when given. When the printed `phases` have no `branch`, the current branch must not be the default branch: stop with `status: failed` otherwise. Done when `init` prints the state.
7. **Loop**: run `ship.mjs next` and act on `action` (see Task State and Phase Map). Before each phase, handle user messages and the interactive checkpoints. Done when `next` returns `finish`.
8. **Outcome**: `ship.mjs outcome`. Pass `--summary` when the default one does not say enough. Done when it prints the outcome JSON.
9. **Summary and run status**: write `<run-dir>/summary.md` per the summary template (`workflow: esp-ship`, the track in the outcome, `status` is the outcome status), from the outcome and `decisions.jsonl`, naming the workspace (`outputs.workspace`) and each skipped phase with its reason (`outputs.skipped_phases`, `outputs.review_gate`), until `runs.mjs check` passes on it. Set `runs.mjs update --status` to the outcome status (`merged`, `done`, `awaiting-human`, `halted`, `failed`).
10. **Report** (see Output Guidance), ending with the reply.

## Output Guidance

A short report, then the reply of decision-policy.md (Replies), built from the outcome. Orchestrated track:

```markdown
### Ship: Add OAuth login (orchestrated)

- **Plan**: plan.md v1, 3 milestones (approved)
- **Branch**: feature/oauth-login from main
- **Build**: M1 1a2b3c4, M2 5d6e7f8 (2 attempts), M3 9a8b7c6 (gates: test pass, lint pass)
- **Internal review**: 2 rounds; 3 fixed, 1 rejected (D006); clean on round 2
- **PR**: https://github.com/o/r/pull/42; claude reviewed it; 1 round, 2 fixed
- **Merge**: squash (the only method the repository allows); remote branch deleted
- **Summary**: ~/.esp-skills/runs/2026-11-10-oauth-login/summary.md
```

```markdown
Status: done
Commit: 9b8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e
Summary: Merged "Add OAuth login" (3 of 3 milestones): https://github.com/o/r/pull/42 with squash.
```

Inline track:

```markdown
### Ship: Add a --json flag to the status command (inline)

- **Branch**: feature/status-json from main
- **Commit**: 4f2a9c1 Add --json flag to the status command (gates: test pass, lint pass)
- **PR**: https://github.com/o/r/pull/43; claude reviewed 4f2a9c1; 2 fixed, 1 rejected (D004)
- **Merge**: squash; remote branch deleted
- **Summary**: ~/.esp-skills/runs/2026-11-10-status-json/summary.md
```

For a track switch, name the trigger and the reason. For a halt or `awaiting-human`, name the phase, the blocker, the pull request (left open), and what would unblock it: the next step is to run the esp-ship skill with `--resume --run-dir <run-dir>`.
