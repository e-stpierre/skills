// esp-orchestrate state: <run-dir>/orchestrate.json and <run-dir>/graph.json,
// their checks, and the helpers shared by the orchestrate modules.
//
// orchestrate.json records the request, the settings of the run, the phase
// (intake, approve, run, done), the plan approval, the status of every unit,
// the waits and the stop. graph.json holds the task graph written by intake
// (see graph.mjs); the per-unit status lives in orchestrate.json, so the
// graph is written once per intake. orchestrate.mjs is the only writer of
// both files.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../lock.mjs";
import {
  configOf,
  freezeConfig,
  INTERACTIVE_MODES,
  MERGE_POLICIES,
  positiveInt,
  projectDirOf,
  readJson,
  runDirOf,
  stringOption,
  writeJson
} from "../ship/state.mjs";
import { now } from "../../runs.mjs";

export class OrchestrateError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "OrchestrateError";
    this.exitCode = exitCode;
  }
}

export const STATE_FORMAT = 1;
export const GRAPH_FORMAT = 1;
export const WORKFLOW = "esp-orchestrate";
export const ORCHESTRATE_PHASES = ["intake", "approve", "run", "done"];
export const UNIT_MODES = ["auto", "subagent", "inline"];
export const UNIT_STATUSES = [
  "pending",
  "running",
  "waiting",
  "merged",
  "done",
  "failed",
  "blocked",
  "awaiting-human",
  "halted"
];
/** Upper bound of max_parallel (the orchestrate.max_parallel schema). */
export const MAX_PARALLEL_LIMIT = 4;

export { INTERACTIVE_MODES, MERGE_POLICIES };

export const statePath = (dir) => join(dir, "orchestrate.json");
export const graphPath = (dir) => join(dir, "graph.json");

/** A fresh per-unit entry of orchestrate.json. */
export function newUnitEntry() {
  return {
    status: "pending",
    mode: null,
    run_dir: null,
    pr: null,
    merge_commit: null,
    reason: null,
    question: null,
    housekept: false,
    started_at: null,
    ended_at: null
  };
}

// ---------------------------------------------------------------------------
// orchestrate.json
// ---------------------------------------------------------------------------

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, min) => Number.isInteger(v) && v >= min;

/** Structural check of a state object; returns a list of error strings. */
export function checkState(state) {
  const errors = [];
  if (state?.state_format !== STATE_FORMAT)
    errors.push(`state_format: expected ${STATE_FORMAT}`);
  if (state?.workflow !== WORKFLOW)
    errors.push(`workflow: expected ${WORKFLOW}`);
  if (typeof state?.request !== "string" || state.request.trim() === "")
    errors.push("request: expected a non-empty string");
  if (!ORCHESTRATE_PHASES.includes(state?.phase))
    errors.push(`phase: expected one of ${ORCHESTRATE_PHASES.join(", ")}`);
  if (!INTERACTIVE_MODES.includes(state?.interactive))
    errors.push(`interactive: expected one of ${INTERACTIVE_MODES.join(", ")}`);
  if (typeof state?.approved !== "boolean")
    errors.push("approved: expected a boolean");
  const s = state?.settings;
  if (!isObject(s)) errors.push("settings: expected an object");
  else {
    if (!UNIT_MODES.includes(s.unit_mode))
      errors.push(
        `settings.unit_mode: expected one of ${UNIT_MODES.join(", ")}`
      );
    if (!isInt(s.max_parallel, 1) || s.max_parallel > MAX_PARALLEL_LIMIT)
      errors.push(
        `settings.max_parallel: expected an integer from 1 to ${MAX_PARALLEL_LIMIT}`
      );
    if (!MERGE_POLICIES.includes(s.merge_policy))
      errors.push(
        `settings.merge_policy: expected one of ${MERGE_POLICIES.join(", ")}`
      );
    if (!isInt(s.max_rounds, 1))
      errors.push("settings.max_rounds: expected an integer >= 1");
    for (const key of ["housekeeping", "write_back"])
      if (typeof s[key] !== "boolean")
        errors.push(`settings.${key}: expected a boolean`);
    if (
      !isObject(s.wait) ||
      !isInt(s.wait.timeout_minutes, 1) ||
      !isInt(s.wait.interval_seconds, 1)
    )
      errors.push(
        "settings.wait: expected { timeout_minutes, interval_seconds } integers >= 1"
      );
  }
  if (!isObject(state?.units)) errors.push("units: expected an object");
  else
    for (const [id, unit] of Object.entries(state.units))
      if (!UNIT_STATUSES.includes(unit?.status))
        errors.push(
          `units.${id}.status: expected one of ${UNIT_STATUSES.join(", ")}`
        );
  if (!isObject(state?.waits)) errors.push("waits: expected an object");
  if (state?.stop !== null && !isObject(state?.stop))
    errors.push("stop: expected null or an object");
  return errors;
}

export function readState(dir) {
  const path = statePath(dir);
  if (!existsSync(path))
    throw new OrchestrateError(
      `No orchestrate.json in ${dir}: run "orchestrate.mjs init" first`
    );
  const state = readJson(path);
  const errors = checkState(state);
  if (errors.length > 0)
    throw new OrchestrateError(`Invalid ${path}:\n  ${errors.join("\n  ")}`);
  return state;
}

/** Write a new orchestrate.json, atomically under its lock. */
export function writeNewState(dir, state) {
  const errors = checkState(state);
  if (errors.length > 0)
    throw new OrchestrateError(`Invalid state:\n  ${errors.join("\n  ")}`);
  withLock(statePath(dir), () => writeJson(statePath(dir), state));
}

/**
 * Read-modify-write orchestrate.json under its lock; returns fn's result,
 * else the state.
 */
export function updateState(dir, fn, env) {
  const path = statePath(dir);
  return withLock(path, () => {
    const state = readState(dir);
    const result = fn(state);
    state.updated_at = now(env).toISOString();
    const errors = checkState(state);
    if (errors.length > 0)
      throw new OrchestrateError(
        `Refusing to write invalid state:\n  ${errors.join("\n  ")}`
      );
    writeJson(path, state);
    return result ?? state;
  });
}

// ---------------------------------------------------------------------------
// graph.json
// ---------------------------------------------------------------------------

/** The recorded graph, or null before intake. */
export function readGraph(dir) {
  const path = graphPath(dir);
  if (!existsSync(path)) return null;
  const graph = readJson(path);
  if (graph?.graph_format !== GRAPH_FORMAT || !Array.isArray(graph?.units))
    throw new OrchestrateError(
      `Invalid ${path}: expected graph_format ${GRAPH_FORMAT} and a units list`
    );
  return graph;
}

/** Write graph.json atomically under its lock. */
export function writeGraph(dir, graph) {
  const path = graphPath(dir);
  withLock(path, () =>
    writeJson(path, { ...graph, graph_format: GRAPH_FORMAT })
  );
  return path;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function choiceOf(value, allowed, name) {
  const given = stringOption(value);
  if (given !== null && !allowed.includes(given))
    throw new OrchestrateError(
      `--${name} must be one of ${allowed.join(", ")}`,
      2
    );
  return given;
}

/** Validate the init options before anything is written. */
function initOptions(options) {
  const request = stringOption(options.request)?.trim();
  if (!request) throw new OrchestrateError("init needs --request <text>", 2);
  const maxParallel =
    options["max-parallel"] === undefined
      ? null
      : positiveInt(options["max-parallel"], "max-parallel");
  if (maxParallel !== null && maxParallel > MAX_PARALLEL_LIMIT)
    throw new OrchestrateError(
      `--max-parallel must be at most ${MAX_PARALLEL_LIMIT}`,
      2
    );
  return {
    request,
    interactive: choiceOf(
      options.interactive,
      INTERACTIVE_MODES,
      "interactive"
    ),
    unitMode: choiceOf(options["unit-mode"], UNIT_MODES, "unit-mode"),
    mergePolicy: choiceOf(
      options["merge-policy"],
      MERGE_POLICIES,
      "merge-policy"
    ),
    maxParallel,
    maxRounds:
      options["max-rounds"] === undefined
        ? null
        : positiveInt(options["max-rounds"], "max-rounds")
  };
}

/**
 * Create orchestrate.json and freeze the config to config.snapshot.json (the
 * snapshot esp-ship --parent-run starts from). Each setting comes from its
 * option, else the orchestrate config section (merge policy: ship, max
 * rounds: fix-review). A second call prints the state.
 */
export function cmdInit(options, env = process.env) {
  const dir = runDirOf(options);
  const path = statePath(dir);
  if (existsSync(path))
    return { state_path: path, created: false, ...readState(dir) };
  const opts = initOptions(options);
  const projectDir = projectDirOf(options, null);
  const snapshot = freezeConfig(dir, { projectDir });
  const config = configOf(snapshot);
  const orch = config.orchestrate ?? {};
  const interactive = opts.interactive ?? config.defaults?.interactive ?? "off";
  if (!INTERACTIVE_MODES.includes(interactive))
    throw new OrchestrateError(
      `interactive must be one of ${INTERACTIVE_MODES.join(", ")}`,
      2
    );
  const at = now(env).toISOString();
  const state = {
    state_format: STATE_FORMAT,
    workflow: WORKFLOW,
    request: opts.request,
    project_dir: projectDir,
    interactive,
    settings: {
      unit_mode: opts.unitMode ?? orch.unit_mode ?? "auto",
      max_parallel: Math.min(
        opts.maxParallel ?? orch.max_parallel ?? 2,
        MAX_PARALLEL_LIMIT
      ),
      merge_policy: opts.mergePolicy ?? config.ship?.merge_policy ?? "auto",
      max_rounds: opts.maxRounds ?? config["fix-review"]?.max_rounds ?? 3,
      housekeeping: options["no-housekeeping"]
        ? false
        : (orch.housekeeping ?? true),
      write_back: options["no-write-back"] ? false : (orch.write_back ?? true),
      wait: {
        timeout_minutes: orch.wait?.timeout_minutes ?? 60,
        interval_seconds: orch.wait?.interval_seconds ?? 30
      }
    },
    phase: "intake",
    approved: false,
    graph_path: null,
    units: {},
    waits: {},
    stop: null,
    config_snapshot: snapshot,
    created_at: at,
    updated_at: at
  };
  writeNewState(dir, state);
  return { state_path: path, created: true, ...state };
}

/** orchestrate.json with the recorded graph (null before intake). */
export function cmdShow(options) {
  const dir = runDirOf(options);
  return { ...readState(dir), graph: readGraph(dir) };
}
