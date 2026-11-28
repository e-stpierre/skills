#!/usr/bin/env node
// esp-skills state and dispatch for esp-orchestrate.
//
// esp-orchestrate takes one request that spans several pull requests,
// possibly across several repositories, to merged code. It runs a task graph
// of units: `build` and `adopt` units ship through esp-ship, `await-pr` waits
// for a pull request to appear then adopts it, and `check` polls a command
// until it succeeds. This script keeps everything deterministic out of the
// model: the orchestrator state, the graph and its validation, the
// repositories of the units, what to run next, and the outcome of the run.
// State lives in <run-dir>/orchestrate.json and the graph in
// <run-dir>/graph.json; this script is the only writer of both, so an
// interrupted run rebuilds what to do from disk.
//
// The logic lives in lib/orchestrate/: state (orchestrate.json, graph.json,
// init, show), graph (validation, order, repositories, intake), next (the
// single next action, its payload and the outcome) and units (the unit, wait,
// approval, housekeeping and resume transitions).
//
// Every command prints JSON to stdout. Exit codes: 0 ok, 1 failure or invalid
// state, 2 usage.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdIntake } from "./lib/orchestrate/graph.mjs";
import { cmdNext } from "./lib/orchestrate/next.mjs";
import {
  cmdInit,
  cmdShow,
  OrchestrateError
} from "./lib/orchestrate/state.mjs";
import {
  cmdApprove,
  cmdHousekeep,
  cmdOutcome,
  cmdResume,
  cmdUnit,
  cmdWait
} from "./lib/orchestrate/units.mjs";

export { OrchestrateError };

const USAGE = `Usage: node orchestrate.mjs <command> [args] --run-dir <path> [options]

Commands:
  init                 Create orchestrate.json (--request <text> --project-dir <path>) and freeze
                       the config to config.snapshot.json, the snapshot every unit's esp-ship
                       --parent-run starts from. Settings come from the options, else the
                       orchestrate config section. A second call prints the state
  show                 Print orchestrate.json with the recorded graph (null before intake)
  intake               Validate a task graph (--graph <file>): unique IDs, kinds, depends_on
                       targets, cycles, owner/name repositories, the fields of each kind and
                       the setting enums; fill the unit defaults from the run and resolve each
                       repository (orchestrate.repos, else the project or a sibling directory
                       whose origin matches): { units, order, unresolved, decisions }. --record
                       writes graph.json, sets every unit pending, moves the run to approve (run
                       with -i off) and logs one decision per sizing choice and per non-auto
                       merge policy. An invalid graph exits 1 with every error and writes nothing
  approve              Record the approval of the graph and the master plan: phase run
  next                 What to run now, exactly one action, read from the files only:
                       intake (no graph), checkpoint (approve-plan with -i plan or all,
                       before-unit with -i all, unresolved-repo), housekeep (a merged unit
                       not housekept: the housekeep.mjs run arguments, with --rebase for the
                       branches of later unstarted build units of the checkout), spawn-unit or
                       run-unit-inline (a unit to resume, then a ready build, adopt, or
                       await-pr that found its pull request: the esp-ship skill
                       arguments), start-wait (a wait to restart, then a ready check or
                       await-pr: the wait-for.mjs arguments), idle (units or waits running)
                       or finish (every unit terminal). A unit is ready when its dependencies
                       are merged or done; at most max_parallel units or waits run at once,
                       never two units of one checkout. Unit mode auto runs inline with -i
                       all, with CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH below 3, or for the
                       last unit left, else as a subagent
  unit <cmd> <id>      Unit transitions: start [--mode subagent|inline] (pending and ready,
                       or resumable, -> running), done --status merged|done [--pr <url>]
                       [--merge-commit <sha>] (running -> merged or done), failed --reason
                       <text> [--status failed|halted] and blocked --reason <text>
                       [--question <text>] (-> awaiting-human). A stopped unit blocks its
                       dependents
  wait <cmd> <id>      Wait of a check or await-pr unit: start (pending and ready -> waiting,
                       prints the wait-for.mjs arguments) or record --result <json|file>
                       (the wait-for.mjs output: a check ends done, an await-pr keeps the
                       found pull request and is ready to adopt, awaiting-human and failed
                       stop the unit)
  housekeep            Record the housekeep.mjs result of a merged unit (--unit <id>
                       --result <json|file>): the unit is housekept, the dirty checkout and
                       the rebased branches are recorded
  resume               Make running units resumable (--resume, same unit run directory),
                       restart the started waits with their state file, and send the units
                       awaiting a human again; their blocked dependents become pending
  outcome              Outcome of the run: merged, partial, awaiting-human, halted or failed
                       (running until every unit is terminal), one entry per unit, the dirty
                       checkouts, and the command that resumes the run

Options:
  --run-dir <path>          Run directory (required)
  --project-dir <path>      init: the repository the request starts from (default: the git root);
                            sibling directories are searched for the unit repositories
  --request <text>          init: the request
  --interactive <mode>      init: off, plan or all (default: defaults.interactive)
  --unit-mode <mode>        init: auto, subagent or inline (default: orchestrate.unit_mode)
  --max-parallel <n>        init: units or waits running at once, 1 to 4
                            (default: orchestrate.max_parallel)
  --merge-policy <policy>   init: default merge policy of the units: auto, human or none
                            (default: ship.merge_policy)
  --max-rounds <n>          init: default pull request fix rounds of the units
                            (default: fix-review.max_rounds)
  --no-housekeeping         init: skip the git housekeeping after each merge
  --no-write-back           init: skip the write-back unit
  --graph <file>            intake: the task graph (JSON)
  --record                  intake: write graph.json and the decisions
  --mode <mode>             unit start: subagent or inline (default: the mode next resolved)
  --status <status>         unit done: merged or done; unit failed: failed or halted
  --pr <url>                unit done: the pull request of the unit
  --merge-commit <sha>      unit done: the merge commit
  --reason <text>           unit failed, unit blocked: why the unit stopped
  --question <text>         unit blocked: what the human has to answer
  --result <json|file>      wait record, housekeep: the JSON output of wait-for.mjs or
                            housekeep.mjs, inline or as a file (its last JSON line)
  --unit <id>               housekeep: the merged unit
  --help                    Show this help`;

const BOOLEAN_FLAGS = new Set([
  "record",
  "resume",
  "no-housekeeping",
  "no-write-back",
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
          throw new OrchestrateError(`--${key} requires a value`, 2);
        options[key] = value;
      }
    } else positional.push(arg);
  }
  return { command: positional[0], args: positional.slice(1), options };
}

export function run(argv, env = process.env) {
  const { command, args, options } = parseArgs(argv);
  if (options.help || !command)
    return { output: USAGE, exitCode: options.help ? 0 : 2 };
  switch (command) {
    case "init":
      return { output: cmdInit(options, env) };
    case "show":
      return { output: cmdShow(options) };
    case "intake":
      return { output: cmdIntake(options, env) };
    case "approve":
      return { output: cmdApprove(options, env) };
    case "next":
      return { output: cmdNext(options, env) };
    case "unit":
      return { output: cmdUnit(args, options, env) };
    case "wait":
      return { output: cmdWait(args, options, env) };
    case "housekeep":
      return { output: cmdHousekeep(options, env) };
    case "resume":
      return { output: cmdResume(options, env) };
    case "outcome":
      return { output: cmdOutcome(options, env) };
    default:
      throw new OrchestrateError(`Unknown command: ${command}\n\n${USAGE}`, 2);
  }
}

const KNOWN_ERRORS = new Set([
  "OrchestrateError",
  "ShipError",
  "ConfigError",
  "RunsError",
  "LockTimeoutError"
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
      `orchestrate error: ${known ? err.message : (err.stack ?? err)}\n`
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
