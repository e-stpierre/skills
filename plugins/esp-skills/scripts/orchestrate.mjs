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
// init, show) and graph (validation, order, repositories, intake).
//
// Every command prints JSON to stdout. Exit codes: 0 ok, 1 failure or invalid
// state, 2 usage.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdIntake } from "./lib/orchestrate/graph.mjs";
import {
  cmdInit,
  cmdShow,
  OrchestrateError
} from "./lib/orchestrate/state.mjs";

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
  approve              Record the approval of the graph and the master plan
  next                 What to run now, exactly one action: intake, checkpoint, housekeep,
                       spawn-unit, run-unit-inline, start-wait, idle or finish
  unit <cmd> <id>      Unit status: start, done, failed or blocked
  wait <cmd> <id>      Wait of a check or await-pr unit: start, or record the wait-for.mjs result
  housekeep            Record the housekeep.mjs result of a merged unit (--unit <id>
                       --result <json|file>)
  resume               Make running units resumable and restart the started waits
  outcome              Outcome of the run: merged, partial, awaiting-human, halted or failed,
                       one entry per unit, and the command that resumes the run

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
  const { command, options } = parseArgs(argv);
  if (options.help || !command)
    return { output: USAGE, exitCode: options.help ? 0 : 2 };
  switch (command) {
    case "init":
      return { output: cmdInit(options, env) };
    case "show":
      return { output: cmdShow(options) };
    case "intake":
      return { output: cmdIntake(options, env) };
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
