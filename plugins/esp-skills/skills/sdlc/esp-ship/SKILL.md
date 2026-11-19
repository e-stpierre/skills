---
name: esp-ship
description: Ship a task to a merged pull request, inline or as verified milestones. Use when asked to take a task, a GitHub issue or a plan all the way to a merged pull request.
argument-hint: "[-u|--resume] [-w|--worktree] [-b|--branch <name>] [-P|--no-pr] [-M|--no-merge] [-D|--draft] [-l|--parallel] [-t|--track <track>] [-L|--plan-mode <mode>] [-R|--review <mode>] [-a|--model <alias>] [-m|--max-rounds <n>] [-r|--reviewers <name>...] [-i|--interactive <mode>] [-d|--run-dir <path>] [context]"
disable-model-invocation: true
---

# ESP Ship

## Overview

Take any task (a one-line fix, a feature prompt, a GitHub issue, a plan from `esp-plan`) to a merged pull request. Triage picks the track: inline (this session, one commit) or orchestrated (a plan, then one verified commit per milestone and an internal review). Both tracks share the pull request tail. `scripts/ship.mjs` decides what runs next and keeps the state in the run directory, so an interrupted run resumes where it stopped.

`preflight -> triage -> [plan] -> branch -> implement (inline) or build (milestones) -> [internal review <-> fix] -> PR -> [wait (reviews + checks) <-> fix-review] -> refresh body -> merge -> summary`

## Arguments

### Definitions

- **`[-u|--resume]`** (optional): Continue the run in `--run-dir` from `ship.json`, with the flags recorded at its start. Lifts an `awaiting-human` stop. `--model` and `--parallel` given with it replace the recorded ones. Fails when the run has no `ship.json`.
- **`[-w|--worktree]`** (optional): Work in a task worktree under `worktrees.root`, so the current checkout stays untouched. Defaults to `ship.worktree` (`false`). A dirty working tree also runs in a task worktree, per `ship.dirty_tree` (`worktree`).
- **`[-b|--branch <name>]`** (optional): Work on this branch: checked out when it exists locally, tracked when it exists on `origin`, else created from `origin/<base>`. Defaults to the current branch when it is not the base or the default branch and the working tree is clean (after the open pull request check, see [workspace.md](references/workspace.md)). Otherwise a new branch named per `branch.pattern`, in a task worktree when the tree is dirty or with `--worktree`.
- **`[-P|--no-pr]`** (optional): Stop after the last commit and the internal review: no push, no pull request.
- **`[-M|--no-merge]`** (optional): Stop after the pull request review fixes, with the pull request left open.
- **`[-D|--draft]`** (optional): Open the pull request as a draft. Defaults to `pr.draft` (`false`). The pull request stays as opened: esp-ship never marks it ready, so a draft ends the task before the merge (esp-merge never merges a draft), with `awaiting-human` and the pull request left open.
- **`[-l|--parallel]`** (optional): Build milestones whose dependencies are done and whose files do not overlap at the same time, each in its own worktree, even when `ship.parallel` would not. Without it, `ship.parallel` decides (`auto`: on when the plan has a batch of two or more such milestones and `worktrees.root` is usable). Recorded in `ship.json`, so a resume keeps it.
- **`[-t|--track <track>]`** (optional): `inline` or `orchestrated`. Pins the track instead of letting triage pick it.
- **`[-L|--plan-mode <mode>]`** (optional): `auto`, `skip` or `always`. `skip` uses no planning model: a plan file is reused, a task list imported, a small request runs inline, and a larger one gets a synthesized one-milestone plan. `always` generates a plan even for a small prompt. Defaults to `ship.plan_mode` (`auto`).
- **`[-R|--review <mode>]`** (optional): `auto`, `internal`, `pr`, `both` or `none`. `internal` keeps only the internal review, `pr` only the bot review rounds, `none` drops both (the merge still needs green checks). `auto` keeps the bot review and decides the internal review after the build from the real diff (see review.md). Defaults to `ship.review_mode` (`auto`).
- **`[-a|--model <alias>]`** (optional): Builder model for every milestone: `opus`, `sonnet`, `haiku` or `fable`. Overrides the complexity-based choice. The verifier keeps its role model. Recorded in `ship.json`, so a resume keeps it.
- **`[-m|--max-rounds <n>]`** (optional): Pull request fix rounds. Defaults to `fix-review.max_rounds` (`3`).
- **`[-r|--reviewers <name>...]`** (optional): Reviewer names from `fix-review.wait.reviewers` (`claude`, `codex`) or GitHub logins, repeated (`-r claude -r codex`) or comma-separated. Defaults to `fix-review.wait.default_reviewers`.
- **`[-i|--interactive <mode>]`** (optional): `off`, `plan` or `all`. `plan` approves the plan (or the inline approach), then runs on its own. `all` also stops at the internal review findings, before and after each pull request fix round, and before the merge. Defaults to `defaults.interactive` (`off`). Headless sessions and subagents always use `off`.
- **`[-d|--run-dir <path>]`** (optional): Run directory to use or to resume. Without it, the skill creates its run under `runs.root`. The config is frozen in `ship.json` on the first call.
- **`[context]`** (required unless resuming, or unless `--run-dir` names a run that already holds a plan): The task: a description, a GitHub issue URL or `#<number>`, or a path to a file that describes it (a plan, a task list, a design document). Without it, a run started by `esp-plan` ships its plan.

### Values

Arguments: $ARGUMENTS

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

- This session orchestrates. It runs the inline phases itself and spawns every other phase in a fresh subagent, keeping only each short reply. Details stay in the run directory
- `ship.mjs next` decides the phase, the model and the loop. Every state change goes through `ship.mjs` and `runs.mjs`, the only writers of `ship.json` (with its step records), `state.json`, `run.json` and `decisions.jsonl`
- Run every script with Bash, with the literal `"${CLAUDE_PLUGIN_ROOT}/scripts/..."` path. The scripts take long option names only, and `--reviewers` as one comma-separated value
- The inline track makes one implementation commit. The orchestrated track makes one verified commit per milestone. Review fixes are separate review-fix commits, titled per `commit.style` (`plain`: `Fix review findings: <summary>`, `conventional`: `fix(review): <summary>`)
- A milestone is done only when an independent `esp-verifier` passes it: the builder's own report never counts
- A halted task stays unmerged. Push only the task branch, force-push only after a rebase of the task branch, and respect branch protection
- Log each decision this session makes with `runs.mjs decision`, when it is made

## Skill-Specific Guidelines

### Configuration

Read the sections once at the start. When the run directory already exists (`--resume`, or `--run-dir` naming a run started by esp-plan), add `--run-dir <run-dir>` to each command, so a resumed run reads its frozen config:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get ship
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get fix-review
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get pr
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get defaults
```

If a command exits with code 1 (invalid config), report its error and stop. If it cannot run at all (no `node`), stop: the dispatch needs the scripts. `ship.mjs` applies most `ship.*` keys itself (phases, budgets, inline limits) and `pr.draft`; the reference file of each phase names the keys it reads. This session reads directly:

- **`pr.base`** (`null`: the repository default branch) and **`defaults.interactive`**: the base and the interactive mode
- **`ship.halt_on`**: the stop conditions honored (see decision-policy.md)
- **`defaults.models.<role>`**: a subagent model, only when `next` gives none (`ship.mjs` resolves the others, see model-selection.md)

`ship.mjs init` freezes the config in the run (`config.snapshot.json`, recorded in `ship.json`), so a resumed run keeps the settings it started with. The phase skills read their own sections (`plan`, `review`, `fix-review`, `merge`, `pr`, `worktrees`) from that snapshot: they get `--run-dir <run-dir>` and pass it to `config.mjs get`, which then uses the snapshot in place of the user and project layers. The branch name comes from the snapshot too (see workspace.md). esp-commit takes no run directory and reads the live `commit` section.

### Task State

`scripts/ship.mjs` owns `<run-dir>/ship.json`, and `ship.mjs milestone <cmd>` owns `<run-dir>/state.json`. Every command takes `--run-dir <path>`. `node "${CLAUDE_PLUGIN_ROOT}/scripts/ship.mjs" --help` lists every command with its options. The ones with rules of their own:

- **`budget`**, **`scope`**, **`gate-failure`**, **`switch-track`**: the inline limits and the move to the orchestrated track (see inline.md)
- **`workspace`**, **`worktree`**: see workspace.md
- **`final-gates`**: see gates.md
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
- **`branch`**: see [workspace.md](references/workspace.md)
- **`build`** (orchestrated track): the milestone loop in this session, see [milestones.md](references/milestones.md)
- **`final-gates`** (orchestrated track): the full gates once in this session, see [gates.md](references/gates.md)
- **`review`** with `sub: review` or `sub: review-fix`: see [review.md](references/review.md)
- **`pr`**, **`fix-review`** (each round starts with the `fix-review-wait` step), **`merge`**: see [pr-tail.md](references/pr-tail.md)

### Phase Subagents

Spawn each subagent phase with the Agent tool, `subagent_type: general-purpose`, with the `model` and `effort` from `next` (omit `model` when it is `inherit`). Record it with `runs.mjs update --model <role>=<model>[:<effort>]`. Run it in the foreground. The prompt is self-contained:

```markdown
You run one phase of an esp-ship task. Read <plugin-root>/skills/<path>/SKILL.md and follow its Instructions as if
invoked with: <arguments>. In that file, ${CLAUDE_PLUGIN_ROOT} means <plugin-root>.
Work in <cwd>. You are a subagent: return any question in your reply (interactive mode off); wait in the foreground, at most
10 minutes per command, when the skill says to wait in the background.
<extra context>
End with the reply that file's Output Guidance describes (Status, Summary, ... lines), and nothing after it.
```

`<plugin-root>` is the value of `${CLAUDE_PLUGIN_ROOT}` in this session (`echo "${CLAUDE_PLUGIN_ROOT}"`). `<arguments>` uses long option names. Every phase skill that takes it also gets `--run-dir <run-dir>`. User messages received since the last phase go in `<extra context>` (see User Messages).

Before spawning a phase, record `phase <name> --status started`. After it returns, act on the `Status:` line of its reply: `done` records `phase <name> --status done`. `halted` runs `ship.mjs stop --status halted --reason <summary>` (the phase logged its Halt decision). `needs-decision` runs `ship.mjs stop --status awaiting-human` with the question as the reason, and `failed` runs `ship.mjs stop --status failed`, unless Waiting and Open Items says otherwise. A subagent whose reply has no `Status:` line counts as `failed` with reason `no status line`. The facts a later step needs (findings, open items, the merge) are in the step the phase skill recorded with `ship.mjs record`, not in the reply.

The milestone builders and verifiers are not phase subagents: this session spawns them as `esp-skills:esp-builder` and `esp-skills:esp-verifier` (see milestones.md).

### Waiting and Open Items

- A plan that replies `needs-decision` (open questions): in `plan` or `all` mode, ask, log the answers as operator decisions, and run the plan phase again with `--amend` and the answers. In `off` mode, `ship.mjs stop --status awaiting-human`.
- Open pull request review items, or a merge blocked by a condition, end the task with `awaiting-human` and the pull request left open.

### Interactive Checkpoints

Only in `plan` or `all` mode (step 1 resolves the mode to `off` when headless or in a subagent). This session does the asking, logs each answer with `runs.mjs decision` (`source: operator`), and passes it to the next subagent in its prompt:

- **After the plan, or after the inline context phase** (`plan`, `all`): approve the plan (title, milestones, risks, open questions) or the approach and the files, or give feedback. Feedback runs the plan again with `--amend`
- **Before each internal fix** (`all`): the findings by class (`outputs.by_class` of the `review-<N>` step in `ship.json`, details in its `outputs.findings_path`). Fix as recommended, or choose for the B items
- **Before each pull request round** (`all`): the review items and failing checks of the round, classified per decision-policy.md and shown by class. Ask for each B-Decide item (its options, the recommended one first) and each B-Scope item (defer, fix now, reject), then pass the answers to the fixer (see Fix Rounds in [pr-tail.md](references/pr-tail.md))
- **After each pull request round** (`all`): the round recap (fixed, rejected, deferred). Continue, or stop with the pull request open
- **Before the merge** (`all`): merge now, or stop with the pull request open

### User Messages

A message the user sends while the task runs is read at the next phase or milestone boundary. Record it with `runs.mjs notes --append <text> --from operator` (add `--milestone <id>` when it concerns one milestone only): every later builder reads it from `notes.md` at the start of its milestone. Pass it also to the next phase subagent in `<extra context>`, or apply it in this session on the inline track. A message that says to stop is `ship.mjs halt --key scope-change` (or `destructive-action` when it names one). A message that changes the plan runs the plan phase again with `--amend` and the message before the next milestone (see Amending in [plan.md](references/plan.md)). On the inline track, a message that widens the task is a `design` escalation (see inline.md).

## Instructions

1. **Parse arguments**: read each option by its short or long name (`-w` or `--worktree`, `-m 2` or `--max-rounds 2`, `--track=inline` too), and the trailing `[context]`. Collect every `-r`/`--reviewers` value into one comma-separated list. Resolve the interactive mode: `-i`/`--interactive`, else `defaults.interactive`, `off` when headless or in a subagent. No `[context]` on a new run is fine when `--run-dir` names a run whose plan exists (`runs.mjs plan --run-dir <path>` prints `version` above `0`): the run ships that plan. `--resume` without `--run-dir`, `--resume` on a run without `ship.json`, an unknown `--track`, `--plan-mode`, `--review` or `--model` value, or no `[context]` on a new run without a plan is a usage error: report it and stop.
2. **Load configuration** (see Configuration). Done when the four sections are read.
3. **Preflight**: a git repository, and `gh auth status` succeeds unless `--no-pr`. A dirty working tree is fine (the branch phase moves the task to a worktree, see [workspace.md](references/workspace.md)), except with `--branch` naming the current branch, or with `ship.dirty_tree: fail`. Otherwise report it and stop with `status: failed`.
4. **Resolve the run**: with `--run-dir`, use it (`runs.mjs create --run-dir <path>` is a no-op on an existing run). Otherwise `runs.mjs create <slug> --title <task title> --workflow esp-ship --repo <owner/name or repo path>`. Resolve the base: `pr.base`, else the repository default branch. Done when the run directory exists and the base is named.
5. **Triage** (new runs only): run `ship.mjs triage` on the request (or, without `[context]`, on the plan of the run) and pick the track and the plan source (see [triage.md](references/triage.md)). Done when `ship.mjs triage --record` has logged the choices. With `nothing_to_do`, skip to step 9 with the triage facts (`result` of `--record`, also in `<run-dir>/triage.json`).
6. **Initialize**: `ship.mjs init --request <request text> --track <track> --base <base> --project-dir <repo-root>`, with `--plan-source <source>` from triage, `--plan-mode` and `--review-mode` when given, and the long form of each other flag that was given (`--no-pr`, `--no-merge`, `--draft`, `--worktree`, `--parallel`, `--model`, `--max-rounds`, `--interactive`, `--reviewers`). Without `[context]`, leave `--request` out: `init` takes the plan title. For a resume, run `ship.mjs init --resume` without `--request`, adding `--model` and `--parallel` when given. When the printed `phases` have no `branch`, the current branch must not be the default branch: stop with `status: failed` otherwise. Done when `init` prints the state.
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

For a track switch, name the trigger and the reason. For a halt or `awaiting-human`, name the phase, the blocker, the pull request (left open), and what would unblock it: the next command is `/esp-skills:esp-ship --resume --run-dir <run-dir>`.
