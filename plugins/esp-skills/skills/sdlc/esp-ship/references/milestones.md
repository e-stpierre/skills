# Milestone Loop

The `build` phase of the orchestrated track. `ship.mjs next` returns `phase: build` with `milestone_loop: true`, `plan_path` and `build_resume`. This session runs the loop itself: for each milestone it delegates to a builder subagent briefed with [esp-builder.md](../../../../agents/esp-builder.md), which implements it and commits, then to a verifier subagent briefed with [esp-verifier.md](../../../../agents/esp-verifier.md), which re-runs the gates and checks the acceptance criteria independently. A failed verification retries the builder, which amends the milestone commit. Exhausted retries halt the build. Every command below is `node "../../../../scripts/ship.mjs" milestone <cmd> --run-dir <run-dir>`.

## Setup

1. `phase build --status started`.
2. `milestone init --base <git rev-parse HEAD>` (in the working directory `cwd` from `next`). It creates `state.json` from the plan, or syncs it with an amended plan and keeps the done milestones. It is safe to repeat, so a resume runs it too. Its `parallel` output (`mode`, `enabled`, `reason`, `max_parallel`, `worktrees_root`, `batches`) says whether `next` returns parallel batches (`ship.parallel`, see the `-l` argument). Log it once as a low-risk `policy` decision (`Build in parallel batches` or `Build one milestone at a time`, with the reason). When the harness cannot run subagents in parallel, log `Build one milestone at a time` with that reason, even with `enabled: true`: its batches then run one milestone after another (see Parallel Batches).
3. Parse the plan once with `node "../../../../scripts/plan.mjs" parse <plan_path>` and keep the milestone blocks.
4. `milestone gates --project-dir <cwd>` once for the full gates, then `milestone gates --milestone <id> --project-dir <cwd>` for each milestone: its `commands` are the scoped checks of its builder and verifier (see gates.md).

## Loop

Run `milestone next` and act on `action`. It returns batches when `milestone init` resolved them on, or when the run was started with `--parallel` (recorded in `ship.json`):

- **`done`**: every milestone is done. Go to Wrap Up
- **`halt`** or **`blocked`**: follow Halting
- **`run`** or **`retry`** with a `batch` of two or more: follow Parallel Batches, then loop
- **`run`** or **`retry`**: build `milestone` with the steps below, then loop

For one milestone:

1. **Operator notes**: record each user message received since the last milestone (see User Messages in SKILL.md). The builder reads it from `notes.md`.
2. **Start**: `milestone start <id> --base <git rev-parse HEAD>` (a retry keeps and prints the base of the first attempt), then `milestone models <id>` (it applies the `--model` recorded in `ship.json`). Record the models with `runs.mjs update --model builder=<model>[:<effort>] --model verifier=<model>`.
3. **Build**: `milestone reuse <id>` decides whether the last builder continues (see Builder Reuse). On `reuse`, continue that builder. On `fresh`, spawn a new one (see Spawning). Then, when the harness returns an agent ID for the subagent, record the builder with `milestone agent <id> --agent-id <agent-id> --tokens <tokens>`, the tokens as the subagent result reports them (leave `--tokens` out when it reports none). Without an agent ID, skip this record: the next `reuse` returns `fresh`. A continued builder does not reread `notes.md`: pass it the operator lines recorded in step 1.
4. **Builder outcome**: read the `Status:` line of its reply. `halted` or `needs-decision` follows Halting. `failed` with no commit runs `milestone finish <id> --status failed --reason <first blocker>`, then loop.
5. **Verify**: spawn the verifier with the builder's commit.
6. **Finish**: verifier `Status: done` runs `milestone finish <id> --status done --commit <commit>`. Otherwise `milestone finish <id> --status failed --commit <commit> --reason <first blocker> --failures '<the Blockers lines as a JSON list of strings>'`: `milestone next` returns them as `failures` on the `retry`. In `all` mode, show the verifier's summary before continuing.

An attempt interrupted while `in-progress` comes back from `next` as a `retry` and counts as used.

## Spawning

Verifiers are always fresh. Delegate each one to a subagent with a fresh context window, briefed with its agent file and the inputs below, with the `model` and `effort` from `milestone models <id>` (they override the agent frontmatter), in the foreground. Keep each prompt self-contained, and keep only each reply (see Replies in the decision policy). A subagent whose reply has no `Status:` line is a failed attempt with reason `no status line`.

In Claude Code, the builder is the `esp-skills:esp-builder` agent type and the verifier the `esp-skills:esp-verifier` agent type, spawned with the Agent tool, which returns the `agentId` and the token count that `milestone agent` records.

Without subagents, follow the agent file in this session for each role, one after another: the builder steps, then the verifier steps as a separate pass that re-runs every gate on the commit instead of trusting the builder's results. The loop, the retries and the records stay the same.

- **Builder** ([esp-builder.md](../../../../agents/esp-builder.md)): the plugin root (`<plugin-root>`, see Phase Subagents in SKILL.md), the milestone block from `plan.mjs parse` (ID, title, goal, tasks, files, acceptance criteria, validation), `--run-dir <run-dir>`, step `build-<id>`, the scoped gate commands of the milestone (`commands` from `milestone gates --milestone <id>`), and the working directory. On a retry, add the commit to amend (`next.amend`) and the verifier failures (`failures` and `last_failure` from `milestone next`)
- **Verifier** ([esp-verifier.md](../../../../agents/esp-verifier.md)): the plugin root, the milestone ID, the acceptance criteria and the validation commands, the expected commit (the `Commit:` line of the builder's reply), the base (from `milestone start`), the expected commit count (`1`), and the gate commands (the scoped commands of the milestone, or the fallback commands the builder named in its `Summary:`)

The builder also records its reply as step `build-<id>` in `ship.json` (`ship.mjs record`), and a retry replaces that record. The verifier records nothing: this session reads its reply.

## Builder Reuse

A builder that just built a related milestone already knows the code, so it continues with the next one instead of a fresh builder rediscovering it. `milestone reuse <id>` decides it deterministically and logs a `policy` decision. Pass `--agent-id <id>` with the agent ID of the last builder this session spawned or continued. Omit it when this session holds none, for example after a resume. `models`, `reuse` and `agent` read the `--model` recorded in `ship.json`, so the builder model they compare is always the same. It returns `decision: reuse` with the `agent_id` to continue only when the milestone is related to the builder's work (a retry, a dependency or shared files), its builder model and effort equal the builder's (a continued agent keeps its own), and the builder's token budget has room (`ship.reuse.limit_tokens`, `ship.reuse.cost.<complexity>`). A parallel batch, a builder that ran in a worktree, and a missing or different agent ID always start fresh. Continuing a builder is an enhancement: in a harness that cannot continue a subagent, or without subagents, pass no agent ID, and every builder starts fresh with the same inputs.

To continue a builder, send the agent `agent_id` the input a fresh builder would get: the milestone block, its step, its scoped gate commands and its messages. On a retry, send the commit to amend and the verifier failures. When the continued builder runs in the background, wait for its completion notice. Then read its facts from the `build-<id>` step in `ship.json` (`ship.mjs show`; its `at` is later than the send), because its reply may not come back as a report. When the send fails or no new record appears, the agent is lost: spawn a fresh builder and record that one. Fresh builders get what earlier builders learned from the run notes (`notes.md`), which they read themselves.

In Claude Code, send it with SendMessage to `agent_id`: the continued builder runs in the background, so wait for its task notification.

## Parallel Batches

`next` returns a `batch` of at most `ship.max_parallel` (default `3`) runnable milestones whose `files` do not overlap. A milestone without files, or whose files cover the whole repository, never runs in a batch.

Batches need parallel subagents and worktrees. When the harness lacks either, build only `milestone` (the first of the batch) in the main tree with the steps for one milestone (see Loop), then run `milestone next` again: it recomputes the batch, so the batch's milestones run one after another in plan order. There are no worktrees, no cherry-picks and no combined gates, since each milestone is built and verified on top of the one before it. Builders of a batch start fresh, and the retries, the halts, the final gates and `state.json` stay the same, so a resume picks up where the build stopped. Otherwise, for a batch:

1. **Worktrees**: for each milestone, create a worktree from the current HEAD: `git worktree add <worktrees_root>/<run-id>-<id> -b <branch>-<id> HEAD` (`worktrees_root` from `milestone init`).
2. **Build and verify**: `milestone start <id> --base <HEAD>` for each milestone, then spawn every builder at once, in parallel, each told to work in its worktree path. Record each one that has an agent ID with `milestone agent <id> --agent-id <agent-id> --worktree`: a batch builder is never continued. Spawn each verifier, in the same worktree, as soon as its builder returns a commit.

   In Claude Code, spawn the builders with several Agent calls in one message.

3. **Integrate**: when every milestone of the batch has a verifier reply, take the verified ones in plan order: `git cherry-pick <commit>` onto the task branch in the main tree, then `milestone finish <id> --status done --commit <new HEAD>`. When a cherry-pick conflicts, run `git cherry-pick --abort` and `milestone finish <id> --status failed --reason "conflict with <ids>"` with no `--commit`: `next` then returns it as a `retry` with a batch of one, which runs sequentially in the main tree from the new HEAD.
4. **Unverified**: finish each milestone whose verifier failed as `failed`, without `--commit` (its commit is not on the task branch). Its retry also runs sequentially.
5. **Clean up**: remove every worktree of the batch (`git worktree remove --force <path>`) and its branch (`git branch -D <branch>-<id>`), even after a failure.
6. **Combined gates**: after integrating two or more milestones, run `milestone gates --files <files of the integrated milestones>` once in the main tree and run its `commands`. If one fails, halt the build with a Halt decision (`gates-exhausted`): the combination broke what each milestone passed alone. The full gates still run once in the `final-gates` phase.

## Halting

Halt the build (log a Halt decision with `phase: build` and the milestone ID in `refs`, then stop the loop) when:

- `next` returns `halt`: retries are exhausted. First run `milestone finish <id> --status halted --reason <reason>` when the milestone is still `failed`
- A builder returns `halted`: finish the milestone as `halted`. A builder returns `needs-decision` with a `Question:` line: finish the milestone as `failed` with the question as `--reason`, so `--resume` retries it with the answer, and ask it in the main session (see the decision policy)
- `next` returns `blocked`: the plan has a dependency that cannot be satisfied

In `all` mode, ask before halting on exhausted retries: the user can grant one more attempt (log it as an operator decision and run `milestone init` again with a higher `ship.max_retries_per_milestone` in a project config), or stop.

Then `ship.mjs halt --key gates-exhausted --reason <reason>` for exhausted retries or a broken combination, or `ship.mjs stop --status awaiting-human|halted --reason <reason>` for a builder that stopped.

## Wrap Up

1. **Squash** (only when `ship.commit_per_milestone` is `false` and every milestone is done): `git reset --soft <state.base>` and one commit titled with the plan title, listing the milestones in the body. Log it as a low-risk decision.
2. `phase build --status done`, then back to the loop of SKILL.md.
