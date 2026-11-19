#!/usr/bin/env node
// esp-skills gate commands, for any skill that runs the project gates
// (esp-fix-review, esp-merge, esp-ship).
//
// `resolve` prints the gate commands of a project: the configured ship.gates.*,
// else the ones detected from the project files (package.json, pyproject.toml,
// ...), and the checks of a scope. It is the same resolution as
// `ship.mjs milestone gates` (lib/ship/gates.mjs), usable without a ship run.
//
// Every command prints JSON to stdout. Exit codes: 0 ok, 1 failure, 2 usage.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gatesForOptions } from "./lib/ship/gates.mjs";
import { ShipError } from "./lib/ship/state.mjs";

const USAGE = `Usage: node gates.mjs resolve [options]

Commands:
  resolve              Gate commands: configured (ship.gates.*), else detected from
                       --project-dir, and the checks of a scope: --milestone <id> (its
                       validation commands plus ship.gates.always, else the full gates) or
                       --files <a,b> (a fix round: the milestones covering those files);
                       { gates, sources, commands, scope, ... }

Options:
  --project-dir <dir>       Repository root (default: cwd)
  --run-dir <path>          Use the run's frozen config snapshot and its recorded plan
  --plan <file>             Plan whose milestones scope --milestone and --files
  --milestone <id>          The checks of one plan milestone
  --files <a,b>             The checks of a fix round touching these files
  --scope milestone|full    Override ship.gates_scope
  --help                    Show this help`;

const VALUE_OPTIONS = new Set([
  "project-dir",
  "run-dir",
  "plan",
  "milestone",
  "files",
  "scope"
]);

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!VALUE_OPTIONS.has(key))
        throw new ShipError(`Unknown option: --${key}`, 2);
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined)
        throw new ShipError(`--${key} requires a value`, 2);
      options[key] = value;
    } else positional.push(arg);
  }
  return { command: positional[0], args: positional.slice(1), options };
}

export function run(argv) {
  const { command, options } = parseArgs(argv);
  if (options.help || !command)
    return { output: USAGE, exitCode: options.help ? 0 : 2 };
  if (command !== "resolve")
    throw new ShipError(`Unknown command: ${command}\n\n${USAGE}`, 2);
  return { output: gatesForOptions(options) };
}

function main() {
  try {
    const { output, exitCode = 0 } = run(process.argv.slice(2));
    const text =
      typeof output === "string" ? output : JSON.stringify(output, null, 2);
    (exitCode === 0 ? process.stdout : process.stderr).write(`${text}\n`);
    process.exitCode = exitCode;
  } catch (err) {
    if (err instanceof ShipError) {
      process.stderr.write(`gates error: ${err.message}\n`);
      process.exitCode = err.exitCode ?? 1;
    } else {
      process.stderr.write(`gates error: ${err.stack ?? err}\n`);
      process.exitCode = 1;
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
