#!/usr/bin/env node
// esp-skills state and dispatch for esp-ship.
//
// esp-ship takes a task from request to merged pull request on one of two
// tracks: inline (one session, one commit) or orchestrated (a plan, milestone
// builders and verifiers, an internal review). Both tracks share the same
// tail: pull request, review wait and fix rounds, body refresh, merge. This
// script keeps everything deterministic out of the model: the phases of the
// track and what to run next, the loops, the limits and budgets, the track
// switch, the task worktree, the milestone state, the step records, the
// pull request body built from the run artifacts, and the outcome of the run.
// State lives in <run-dir>/ship.json and, for the milestones, in
// <run-dir>/state.json, so an interrupted run resumes.
//
// The logic lives in lib/ship/: state, phases, review-loop, tail, inline,
// milestones, steps, gates, workspace, triage, review-gate and base-sync.
//
// Every command prints JSON to stdout. Exit codes: 0 ok, 1 failure or invalid
// state, 2 usage.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cmdGateFailure,
  cmdScope,
  cmdSwitchTrack
} from "./lib/ship/inline.mjs";
import {
  cmdAgent,
  cmdFinish,
  cmdMilestoneGates,
  cmdMilestoneInit,
  cmdMilestoneNext,
  cmdModels,
  cmdReuse,
  cmdStart,
  readMilestoneState
} from "./lib/ship/milestones.mjs";
import {
  budgetCheck,
  cmdInit,
  cmdNext,
  cmdPhase,
  cmdStop
} from "./lib/ship/phases.mjs";
import { cmdBaseSync } from "./lib/ship/base-sync.mjs";
import { reviewLoop } from "./lib/ship/review-loop.mjs";
import { readState, runDirOf, ShipError } from "./lib/ship/state.mjs";
import { cmdRecord } from "./lib/ship/steps.mjs";
import { cmdHalt, cmdOutcome, cmdPrBody, cmdPrLoop } from "./lib/ship/tail.mjs";
import { cmdFinalGates } from "./lib/ship/gates.mjs";
import { cmdReviewGate } from "./lib/ship/review-gate.mjs";
import { cmdTriage } from "./lib/ship/triage.mjs";
import { cmdWorkspace, cmdWorktree } from "./lib/ship/workspace.mjs";
import { now } from "./runs.mjs";

export { ShipError };

const USAGE = `Usage: node ship.mjs <command> [args] --run-dir <path> [options]

Commands:
  triage               Before init: detect the request (--request <text|path|issue>; without it, the
                       plan already in --run-dir) and pick the
                       plan source and the track: { input_kind, plan_source, track, nothing_to_do,
                       needs_judgment, packages, ... }. --track pins the track; for a prompt or an
                       issue, --judged-track inline|orchestrated --estimate <files> --reason <text>
                       passes the model's judgment. --plan-mode auto|skip|always changes the plan
                       of a prompt or an issue. --record (needs --run-dir) logs one decision per
                       choice and writes triage.json
  init                 Create ship.json (--request <text> --track inline|orchestrated --base <branch>;
                       without --request, the title of the plan in the run directory); resolves
                       the phases of the track and freezes the config. A second call prints the
                       state; --resume lifts an awaiting-human stop (and takes --model, --parallel)
  show                 Print ship.json
  next                 What to run now: { action, track, phase, sub, skill, role, model, effort, cwd, ... };
                       action finish means every phase ended: go to the outcome
  phase <name>         Record a phase: --status started|done|skipped|failed, and its facts
                       (--plan <file>, --branch, --base, --base-sha, --commit, --pr, --summary,
                       --gates <json>, --reason)
  record <step>        Record the facts of a step (review-<N>, fix-review-<N>, fix-review-wait,
                       fix-review, merge, ...) in ship.json, from --json <object> or stdin: the JSON
                       a script printed ({ status, summary, commit, blockers, discovered_items,
                       outputs }; an outcome key is unwrapped). Recording a step again replaces it
  final-gates          Record one run of the full gates in the main tree (--result pass|fail
                       [--gates <json>] [--reason <text>]): continue, fix (one fixer round),
                       halt (gates-exhausted) or continue-failing
  review-gate          After the build, review_mode auto: decide the internal review from the
                       diff (files, lines), the milestone complexities, max_risk and
                       ship.review.always_paths; a skip marks the review phase skipped. Logs
                       one policy decision; later calls print the recorded gate
  review-loop          Internal review loop state: review, fix, done, stop or halt
  pr-loop              Pull request rounds after a step (--after wait|fix): wait, fix, merge or stop
  workspace            Branch phase: pick the workspace (checkout, existing-branch, worktree) from
                       --branch <name>, the current branch, the dirty files and ship.dirty_tree,
                       and apply it; without a branch name it may return action name-branch.
                       --new-branch never reuses the current branch, and replaces a recorded
                       workspace that only reused it
  worktree             Create the task worktree on --branch <name> (from --from, default origin/<base>)
  base-sync            Before the pull request: fetch origin/<base> in the workspace and compare it
                       with the base of the branch: { action: none|rebase|gates|push, base, onto,
                       behind } (gates or push: a resume after an unfinished rebase or gates)
                       (an adopted pull request returns none with a reason). --record --result
                       rebased|conflict|pass|fail [--reason <text>] records the outcome in
                       base_sync: rebased updates base_sha, conflict stops awaiting-human, fail
                       halts gates-exhausted (a failed stop when the key is not in halt_on)
  budget               Elapsed wall time vs the track's max_wall_minutes
  scope                Inline track: changed files since the base vs max_files_changed
                       (--estimate <n> checks a planned file count instead)
  gate-failure         Inline track: count a gate failure (--reason); the second escalates, or halts
  switch-track         Inline run: move to the orchestrated track in place (--to orchestrated
                       --trigger files|design|gates --reason <text>); logs the Escalate decision
  stop                 Record a stop (--status awaiting-human|failed|halted --reason <text>)
  halt                 Halt under a halt_on key (--key --reason), log it, record it and print the halt
  pr-body              Pull request body from the run artifacts (--summary <text>, --out <file>): the
                       body of runs.mjs pr-body, with the frozen config and the plan overview or
                       the request as the default summary
  outcome              Outcome of the run for summary.md and the report (--status, --summary)
  milestone <cmd>      Milestone state (state.json) of the orchestrated track:
    init               Create state.json from the latest plan (or --plan), or sync it with an
                       amended plan; uses the run's frozen config
    next               What to run now: { action: run|retry|halt|done|blocked, milestone, batch }
                       (--parallel for a batch; defaults to the one recorded by init)
    start <id>         Begin an attempt of a milestone
    finish <id>        End the attempt: --status done|failed|halted [--commit <sha>] [--reason <text>]
                       [--failures <json>] (the verifier's failures, returned by next on the retry)
    models <id>        Builder and verifier { model, effort } (--model <model> [--effort <level>];
                       --model defaults to the one recorded by init)
    reuse <id>         Continue the last builder with a milestone or spawn a fresh one:
                       { decision: reuse|fresh, agent_id, reason, used, cost, limit }; logs a
                       policy decision (--agent-id <id> held by this session, --parallel,
                       --model, --effort)
    agent <id>         Record the builder agent of the current attempt (--agent-id <id>
                       [--tokens <n> reported by the subagent result] [--worktree]
                       [--model <m>] [--effort <e>] as given to milestone models)
    gates              Gate commands: configured, else detected from --project-dir, and the
                       checks of a scope: --milestone <id> (its validation commands plus
                       ship.gates.always, else the full gates) or --files <a,b> (a fix round:
                       the milestones covering those files); --scope milestone|full
    show               Print state.json

Options:
  --run-dir <path>          Run directory (required except by milestone gates)
  --project-dir <dir>       Repository root (default: recorded at init, else the git root)
  --track <track>           init, triage: inline or orchestrated (init default: orchestrated)
  --request <text>          init, triage: the task, an issue reference or a file path
  --record                  triage: log the decisions and write triage.json; base-sync: record
                            the --result of the rebase or of the gates after it
  --plan-source <source>    init: reuse, import, generate or synthesize the plan (default: reuse
                            a plan in the run directory, else generate)
  --plan-mode <mode>        init, triage: auto, skip or always (default: ship.plan_mode)
  --review-mode <mode>      init: auto, internal, pr, both or none (default: ship.review_mode)
  --no-pr, --no-merge       init: stop before the pull request, or before the merge
  --draft                   init: open the pull request as a draft (default: pr.draft)
  --model <model>           init: builder model of every milestone: a Claude Code alias (opus,
                            sonnet, haiku, fable), a tier (low, medium, high: the
                            defaults.models.builder entry) or a harness model name (gpt-5.5-codex)
  --parallel                init: build milestone batches even when ship.parallel would not
  --resume                  init: resume the run (see init)
  --worktree                init: work in a task worktree (default: ship.worktree)
  --branch <name>           workspace: the task branch (checked out, tracked from origin or created)
  --new-branch              workspace: name a new branch instead of reusing the current one
  --max-rounds <n>          init: pull request fix rounds (default: fix-review.max_rounds)
  --interactive <mode>      init: off, plan or all (default: defaults.interactive)
  --reviewers <names>       init: reviewers to wait for and fix
  --pr <url>                init: adopt an open pull request (inline track): context, implement and
                            pr are skipped; branch checks out its head, then the review wait, the
                            fix rounds and the merge run (default request: the URL)
  --merge-policy <policy>   init: auto (esp-merge merges), human (wait for a person to merge) or
                            none (skip the merge) (default: ship.merge_policy); next returns it
                            for the merge phase
  --checks <mode>           init: required, or none-expected for a pull request that runs no
                            checks: no checks grace period (next returns checks_grace_seconds 0
                            for fix-review), logged as a policy decision (default: required)
  --parent-run <dir>        init: link the run and its parent run (both run.json files) and
                            freeze the config from the parent config.snapshot.json, with the
                            project config over it
  --help                    Show this help`;

const BOOLEAN_FLAGS = new Set([
  "no-pr",
  "no-merge",
  "worktree",
  "draft",
  "resume",
  "record",
  "parallel",
  "new-branch",
  "help"
]);

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h") options.help = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (BOOLEAN_FLAGS.has(key))
        options[key] = eq === -1 ? true : arg.slice(eq + 1) !== "false";
      else {
        const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
        if (value === undefined)
          throw new ShipError(`--${key} requires a value`, 2);
        options[key] = value;
      }
    } else positional.push(arg);
  }
  return { command: positional[0], args: positional.slice(1), options };
}

function runMilestone(sub, args, options, env) {
  switch (sub) {
    case "init":
      return { output: cmdMilestoneInit(options, env) };
    case "next":
      return { output: cmdMilestoneNext(options) };
    case "start":
      return { output: cmdStart(args[0], options, env) };
    case "finish":
      return { output: cmdFinish(args[0], options, env) };
    case "models":
      return { output: cmdModels(args[0], options) };
    case "reuse":
      return { output: cmdReuse(args[0], options, env) };
    case "agent":
      return { output: cmdAgent(args[0], options, env) };
    case "gates":
      return { output: cmdMilestoneGates(options) };
    case "show":
      return { output: readMilestoneState(runDirOf(options)) };
    default:
      throw new ShipError(
        `Unknown milestone command: ${sub ?? "(missing)"}\n\n${USAGE}`,
        2
      );
  }
}

export function run(argv, env = process.env) {
  const { command, args, options } = parseArgs(argv);
  if (options.help || !command)
    return { output: USAGE, exitCode: options.help ? 0 : 2 };
  switch (command) {
    case "triage":
      return { output: cmdTriage(options, env) };
    case "init":
      return { output: cmdInit(options, env) };
    case "show":
      return { output: readState(runDirOf(options)) };
    case "next":
      return { output: cmdNext(options, env) };
    case "phase":
      return { output: cmdPhase(args[0], options, env) };
    case "record":
      return { output: cmdRecord(args[0], options, env) };
    case "final-gates":
      return { output: cmdFinalGates(options, env) };
    case "review-gate":
      return { output: cmdReviewGate(options, env) };
    case "review-loop": {
      const dir = runDirOf(options);
      return { output: reviewLoop(dir, readState(dir)) };
    }
    case "pr-loop":
      return { output: cmdPrLoop(options, env) };
    case "workspace":
      return { output: cmdWorkspace(options, env) };
    case "worktree":
      return { output: cmdWorktree(options, env) };
    case "base-sync":
      return { output: cmdBaseSync(options, env) };
    case "budget":
      return { output: budgetCheck(readState(runDirOf(options)), now(env)) };
    case "scope":
      return { output: cmdScope(options) };
    case "gate-failure":
      return { output: cmdGateFailure(options, env) };
    case "switch-track":
      return { output: cmdSwitchTrack(options, env) };
    case "stop":
      return { output: cmdStop(options, env) };
    case "halt":
      return { output: cmdHalt(options, env) };
    case "pr-body":
      return { output: cmdPrBody(options) };
    case "outcome":
      return { output: cmdOutcome(options) };
    case "milestone":
      return runMilestone(args[0], args.slice(1), options, env);
    default:
      throw new ShipError(`Unknown command: ${command}\n\n${USAGE}`, 2);
  }
}

const KNOWN_ERRORS = new Set([
  "ShipError",
  "ConfigError",
  "RunsError",
  "LockTimeoutError",
  "PlanError"
]);

function main() {
  try {
    const { output, exitCode = 0 } = run(process.argv.slice(2));
    const text =
      typeof output === "string" ? output : JSON.stringify(output, null, 2);
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    process.exitCode = exitCode;
  } catch (err) {
    const known = KNOWN_ERRORS.has(err.name);
    process.stderr.write(
      `ship error: ${known ? err.message : (err.stack ?? err)}\n`
    );
    process.exitCode = known ? (err.exitCode ?? 1) : 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
