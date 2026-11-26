// esp-orchestrate transitions: the unit, wait, approval, housekeeping, resume
// and outcome commands. Each one validates the transition against the
// recorded state before it writes, and refreshes the blocked units: a pending
// unit with a failed, awaiting-human, halted or blocked dependency becomes
// blocked, and a blocked unit whose dependencies recovered (after resume)
// becomes pending again.
//
// Unit statuses: pending -> running (unit start) -> merged or done (unit
// done), failed or halted (unit failed), awaiting-human (unit blocked). A
// check, or an await-pr with no pull request yet, waits instead: pending ->
// waiting (wait start) -> done, pending with the found pull request (an
// await-pr, then adopted with unit start), awaiting-human or failed (wait
// record).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expandHome } from "../../config.mjs";
import { now } from "../../runs.mjs";
import { runDirOf, SHA, stringOption } from "../ship/state.mjs";
import { PR_KINDS, topoOrder } from "./graph.mjs";
import {
  awaitsRelaunch,
  effectiveStatuses,
  isReady,
  isWaitUnit,
  outcomeOf,
  resolveMode,
  samePath,
  STOPPED,
  TERMINAL,
  unitRunDir,
  waitAction
} from "./next.mjs";
import {
  OrchestrateError,
  readGraph,
  readState,
  updateState
} from "./state.mjs";

export const UNIT_COMMANDS = ["start", "done", "failed", "blocked"];
export const WAIT_COMMANDS = ["start", "record"];
const RUN_MODES = ["subagent", "inline"];
const DONE_STATUSES = ["merged", "done"];
const FAILED_STATUSES = ["failed", "halted"];
const WAIT_RESULTS = ["done", "awaiting-human", "failed", "waiting"];
const HOUSEKEEP_RESULTS = ["done", "skipped", "partial", "failed"];
const PR_URL = /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The run directory and its recorded graph; fails before intake. */
function loadRun(options) {
  const dir = runDirOf(options);
  readState(dir);
  const graph = readGraph(dir);
  if (!graph)
    throw new OrchestrateError(
      `No graph.json in ${dir}: run "orchestrate.mjs intake --record" first`
    );
  return { dir, graph };
}

function unitOf(graph, id, command) {
  if (!id) throw new OrchestrateError(`${command} needs a unit ID`, 2);
  const unit = graph.units.find((u) => u.id === id);
  if (!unit)
    throw new OrchestrateError(
      `Unknown unit ${id} (units: ${graph.units.map((u) => u.id).join(", ")})`
    );
  return unit;
}

function required(options, key, command) {
  const value = stringOption(options[key])?.trim();
  if (!value) throw new OrchestrateError(`${command} needs --${key}`, 2);
  return value;
}

function choice(options, key, allowed, fallback) {
  const value = stringOption(options[key]) ?? fallback;
  if (!allowed.includes(value))
    throw new OrchestrateError(
      `--${key} must be one of ${allowed.join(", ")}`,
      2
    );
  return value;
}

/** Units in a run phase only: after intake and the plan approval. */
function requireRunPhase(state) {
  if (state.phase === "approve")
    throw new OrchestrateError(
      'The graph is not approved yet: run "orchestrate.mjs approve" first'
    );
  if (state.phase !== "run")
    throw new OrchestrateError(
      `The run is in phase ${state.phase}: units start only in phase run`
    );
}

/**
 * Block the pending units with a stopped dependency and unblock the blocked
 * units whose dependencies recovered, in dependency order.
 */
export function refreshBlocked(state, graph, at) {
  const byId = new Map(graph.units.map((u) => [u.id, u]));
  const changed = [];
  for (const id of topoOrder(graph)) {
    const entry = state.units[id];
    if (!entry) continue;
    const dep = byId
      .get(id)
      .depends_on.find((d) => STOPPED.has(state.units[d]?.status));
    if (entry.status === "pending" && dep) {
      entry.status = "blocked";
      entry.reason = `dependency ${dep} is ${state.units[dep].status}`;
      entry.ended_at = at;
      changed.push(id);
    } else if (
      entry.status === "blocked" &&
      !dep &&
      entry.reason?.startsWith("dependency ")
    ) {
      entry.status = "pending";
      entry.reason = null;
      entry.ended_at = null;
      changed.push(id);
    }
  }
  return changed;
}

/**
 * A JSON result given inline or as a file. A file may hold the whole output
 * of the script: its last line that parses as a JSON object wins.
 */
export function readResult(raw, name) {
  const text = stringOption(raw)?.trim();
  if (!text) throw new OrchestrateError(`--${name} <json|file> is required`, 2);
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new OrchestrateError(`--${name}: invalid JSON (${err.message})`, 2);
    }
  }
  const path = resolve(expandHome(text));
  if (!existsSync(path))
    throw new OrchestrateError(`--${name}: file not found: ${path}`);
  const content = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(content);
  } catch {
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines.reverse()) {
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object" && !Array.isArray(value))
          return value;
      } catch {
        // Not a JSON line: keep looking.
      }
    }
  }
  throw new OrchestrateError(`--${name}: no JSON object in ${path}`);
}

// ---------------------------------------------------------------------------
// unit start|done|failed|blocked
// ---------------------------------------------------------------------------

function unitStart(dir, graph, unit, options, env) {
  const mode =
    options.mode === undefined ? null : choice(options, "mode", RUN_MODES);
  return updateState(
    dir,
    (s) => {
      requireRunPhase(s);
      const entry = s.units[unit.id];
      const statuses = effectiveStatuses(s, graph);
      if (!PR_KINDS.includes(unit.kind) || isWaitUnit(unit, entry))
        throw new OrchestrateError(
          `Unit ${unit.id} is a ${unit.kind} unit with no pull request yet: start its wait with "wait start ${unit.id}"`
        );
      const resumed = entry.status === "running" && entry.resume === true;
      if (!resumed) {
        if (statuses[unit.id] !== "pending")
          throw new OrchestrateError(
            `Unit ${unit.id} is ${statuses[unit.id]}: only a pending unit starts`
          );
        const waiting = unit.depends_on.filter(
          (d) => !DONE_STATUSES.includes(statuses[d])
        );
        if (waiting.length > 0)
          throw new OrchestrateError(
            `Unit ${unit.id} is not ready: ${waiting.map((d) => `${d} is ${statuses[d]}`).join(", ")}`
          );
        if (!unit.repo_dir)
          throw new OrchestrateError(
            `Unit ${unit.id} has no checkout of ${unit.repo}: resolve its repository first`
          );
      }
      // A resumed unit only waits for the units already relaunched: the
      // others of its checkout are still awaiting their own relaunch.
      const other = graph.units.find(
        (u) =>
          u.id !== unit.id &&
          PR_KINDS.includes(u.kind) &&
          s.units[u.id]?.status === "running" &&
          !(resumed && awaitsRelaunch(s.units[u.id])) &&
          samePath(u.repo_dir, unit.repo_dir)
      );
      if (other)
        throw new OrchestrateError(
          `Unit ${other.id} is running in ${unit.repo_dir}: units of one checkout run one at a time`
        );
      const at = now(env).toISOString();
      const resolved =
        mode ??
        resolveMode(s, unit.id, env, statuses, resumed ? entry.mode : null)
          .mode;
      entry.status = "running";
      entry.mode = resolved;
      entry.run_dir = unitRunDir(dir, unit.id);
      entry.started_at = resumed ? (entry.started_at ?? at) : at;
      entry.ended_at = null;
      entry.resume = false;
      return {
        unit: unit.id,
        status: "running",
        mode: resolved,
        run_dir: entry.run_dir,
        resumed
      };
    },
    env
  );
}

function unitDone(dir, graph, unit, options, env) {
  const status = choice(options, "status", DONE_STATUSES, null);
  const pr = stringOption(options.pr);
  if (pr !== null && !PR_URL.test(pr))
    throw new OrchestrateError("--pr must be a pull request URL", 2);
  const commit = stringOption(options["merge-commit"]);
  if (commit !== null && !SHA.test(commit))
    throw new OrchestrateError("--merge-commit must be a commit SHA", 2);
  return updateState(
    dir,
    (s) => {
      const entry = s.units[unit.id];
      if (entry.status !== "running")
        throw new OrchestrateError(
          `Unit ${unit.id} is ${entry.status}: only a running unit is done`
        );
      entry.status = status;
      entry.pr = pr ?? entry.pr ?? unit.pr ?? null;
      entry.merge_commit = commit ?? entry.merge_commit ?? null;
      entry.reason = null;
      entry.question = null;
      entry.resume = false;
      entry.ended_at = now(env).toISOString();
      return {
        unit: unit.id,
        status,
        pr: entry.pr,
        merge_commit: entry.merge_commit
      };
    },
    env
  );
}

/** unit failed and unit blocked: stop a pending, running or waiting unit. */
function unitStop(dir, graph, unit, env, { status, reason, question }) {
  return updateState(
    dir,
    (s) => {
      const entry = s.units[unit.id];
      const current = effectiveStatuses(s, graph)[unit.id];
      if (TERMINAL.has(current))
        throw new OrchestrateError(
          `Unit ${unit.id} is already ${current}: only a pending, running or waiting unit stops`
        );
      const at = now(env).toISOString();
      if (entry.status === "waiting" && s.waits[unit.id]) {
        s.waits[unit.id].status = "stopped";
        s.waits[unit.id].restart = false;
        s.waits[unit.id].ended_at = at;
      }
      entry.status = status;
      entry.reason = reason;
      entry.question = question;
      entry.resume = false;
      entry.ended_at = at;
      const blocked = refreshBlocked(s, graph, at);
      return {
        unit: unit.id,
        status,
        reason: entry.reason,
        question,
        blocked
      };
    },
    env
  );
}

export function cmdUnit(args, options, env = process.env) {
  const [sub, id] = args;
  if (!UNIT_COMMANDS.includes(sub))
    throw new OrchestrateError(
      `unit needs a command: ${UNIT_COMMANDS.join(", ")}`,
      2
    );
  const { dir, graph } = loadRun(options);
  const unit = unitOf(graph, id, `unit ${sub}`);
  switch (sub) {
    case "start":
      return unitStart(dir, graph, unit, options, env);
    case "done":
      return unitDone(dir, graph, unit, options, env);
    case "failed":
      return unitStop(dir, graph, unit, env, {
        status: choice(options, "status", FAILED_STATUSES, "failed"),
        reason: required(options, "reason", "unit failed"),
        question: null
      });
    default:
      return unitStop(dir, graph, unit, env, {
        status: "awaiting-human",
        reason: required(options, "reason", "unit blocked"),
        question: stringOption(options.question)?.trim() || null
      });
  }
}

// ---------------------------------------------------------------------------
// wait start|record
// ---------------------------------------------------------------------------

function waitStart(dir, graph, unit, env) {
  return updateState(
    dir,
    (s) => {
      requireRunPhase(s);
      const entry = s.units[unit.id];
      if (!isWaitUnit(unit, entry))
        throw new OrchestrateError(
          unit.kind === "await-pr"
            ? `Unit ${unit.id} already found ${entry.pr}: start it with "unit start ${unit.id}"`
            : `Unit ${unit.id} is a ${unit.kind} unit: start it with "unit start ${unit.id}"`
        );
      const statuses = effectiveStatuses(s, graph);
      const wait = s.waits[unit.id];
      const restart = entry.status === "waiting" && wait?.restart === true;
      if (!restart) {
        if (entry.status === "waiting")
          throw new OrchestrateError(
            `Unit ${unit.id} is already waiting: record its result with "wait record ${unit.id}"`
          );
        if (statuses[unit.id] !== "pending")
          throw new OrchestrateError(
            `Unit ${unit.id} is ${statuses[unit.id]}: only a pending unit starts its wait`
          );
        if (!isReady(unit, statuses))
          throw new OrchestrateError(
            `Unit ${unit.id} is not ready: ${unit.depends_on
              .filter((d) => !DONE_STATUSES.includes(statuses[d]))
              .map((d) => `${d} is ${statuses[d]}`)
              .join(", ")}`
          );
      }
      const at = now(env).toISOString();
      const action = waitAction(unit, { runDir: dir, restart });
      s.waits[unit.id] = {
        kind: action.wait,
        status: "started",
        state_file: action.state_file,
        args: action.args,
        started_at: restart ? (wait.started_at ?? at) : at,
        restarted_at: restart ? at : null,
        restart: false,
        ended_at: null,
        summary: null
      };
      entry.status = "waiting";
      entry.started_at = entry.started_at ?? at;
      entry.ended_at = null;
      return {
        unit: unit.id,
        status: "waiting",
        restart,
        state_file: action.state_file,
        script: action.script,
        args: action.args,
        command: action.command,
        record: action.record
      };
    },
    env
  );
}

function waitRecord(dir, graph, unit, options, env) {
  const result = readResult(options.result, "result");
  if (!WAIT_RESULTS.includes(result?.status))
    throw new OrchestrateError(
      `--result: status must be one of ${WAIT_RESULTS.join(", ")}, got ${JSON.stringify(result?.status)}`
    );
  return updateState(
    dir,
    (s) => {
      const entry = s.units[unit.id];
      const wait = s.waits[unit.id];
      if (entry.status !== "waiting" || !wait)
        throw new OrchestrateError(
          `Unit ${unit.id} is ${entry.status}: only a waiting unit records a wait result`
        );
      const kind = result.outputs?.kind;
      if (kind !== undefined && kind !== wait.kind)
        throw new OrchestrateError(
          `--result is a ${kind} wait, unit ${unit.id} waits with ${wait.kind}`
        );
      const at = now(env).toISOString();
      wait.summary = result.summary ?? null;
      wait.deadline = result.outputs?.deadline ?? wait.deadline ?? null;
      wait.polls = result.outputs?.polls ?? wait.polls ?? null;
      const out = { unit: unit.id, wait: result.status };
      if (result.status === "waiting") return { ...out, status: "waiting" };
      wait.status = result.status;
      wait.ended_at = at;
      if (result.status === "done" && unit.kind === "await-pr") {
        const pr = result.outputs?.pr;
        if (!pr?.url)
          throw new OrchestrateError(
            "--result: a done pr wait needs outputs.pr.url"
          );
        entry.status = "pending";
        entry.pr = pr.url;
        entry.found_pr = pr;
        return { ...out, status: "pending", pr: pr.url, ready: true };
      }
      entry.status = result.status;
      entry.ended_at = at;
      entry.reason = result.status === "done" ? null : (result.summary ?? null);
      const blocked = refreshBlocked(s, graph, at);
      return { ...out, status: entry.status, reason: entry.reason, blocked };
    },
    env
  );
}

export function cmdWait(args, options, env = process.env) {
  const [sub, id] = args;
  if (!WAIT_COMMANDS.includes(sub))
    throw new OrchestrateError(
      `wait needs a command: ${WAIT_COMMANDS.join(", ")}`,
      2
    );
  const { dir, graph } = loadRun(options);
  const unit = unitOf(graph, id, `wait ${sub}`);
  if (!["check", "await-pr"].includes(unit.kind))
    throw new OrchestrateError(
      `Unit ${unit.id} is a ${unit.kind} unit: only check and await-pr units wait`
    );
  return sub === "start"
    ? waitStart(dir, graph, unit, env)
    : waitRecord(dir, graph, unit, options, env);
}

// ---------------------------------------------------------------------------
// approve, housekeep, resume, outcome
// ---------------------------------------------------------------------------

/** Record the approval of the graph and the master plan. */
export function cmdApprove(options, env = process.env) {
  const { dir } = loadRun(options);
  return updateState(
    dir,
    (s) => {
      if (s.phase !== "approve" && s.phase !== "run")
        throw new OrchestrateError(
          `The run is in phase ${s.phase}: nothing to approve`
        );
      const already = s.approved;
      s.approved = true;
      s.approved_at = s.approved_at ?? now(env).toISOString();
      s.phase = "run";
      return { approved: true, already_approved: already, phase: s.phase };
    },
    env
  );
}

/** Record the housekeep.mjs result of a merged unit. */
export function cmdHousekeep(options, env = process.env) {
  const id = stringOption(options.unit);
  if (!id) throw new OrchestrateError("housekeep needs --unit <id>", 2);
  const result = readResult(options.result, "result");
  if (!HOUSEKEEP_RESULTS.includes(result?.status))
    throw new OrchestrateError(
      `--result: status must be one of ${HOUSEKEEP_RESULTS.join(", ")}, got ${JSON.stringify(result?.status)}`
    );
  if (result.steps !== undefined && !Array.isArray(result.steps))
    throw new OrchestrateError("--result: steps must be a list");
  const { dir, graph } = loadRun(options);
  const unit = unitOf(graph, id, "housekeep");
  return updateState(
    dir,
    (s) => {
      const entry = s.units[unit.id];
      if (entry.status !== "merged")
        throw new OrchestrateError(
          `Unit ${unit.id} is ${entry.status}: only a merged unit is housekept`
        );
      if (entry.housekept)
        throw new OrchestrateError(`Unit ${unit.id} is already housekept`);
      const at = now(env).toISOString();
      const steps = result.steps ?? [];
      entry.housekept = true;
      entry.housekeeping = {
        status: result.status,
        summary: result.summary ?? null,
        reason: result.reason ?? null,
        files: result.files ?? [],
        base: result.base ?? null,
        at
      };
      const rebased = [];
      const statuses = effectiveStatuses(s, graph);
      for (const step of steps.filter((st) => st?.step === "rebase")) {
        for (const other of graph.units) {
          if (
            other.id === unit.id ||
            other.kind !== "build" ||
            other.settings?.branch !== step.target ||
            statuses[other.id] !== "pending" ||
            !samePath(other.repo_dir, unit.repo_dir)
          )
            continue;
          s.units[other.id].rebase = {
            result: step.result ?? null,
            detail: step.detail ?? null,
            base: result.base ?? null,
            by: unit.id,
            at
          };
          rebased.push({
            unit: other.id,
            branch: step.target,
            result: step.result ?? null
          });
        }
      }
      return {
        unit: unit.id,
        housekept: true,
        status: result.status,
        dirty: result.status === "skipped" && result.reason === "dirty",
        rebased
      };
    },
    env
  );
}

/**
 * Make the run resumable from disk: running units resume their esp-ship run
 * (--resume, same unit run directory), started waits restart with their
 * state file (keeping the deadline), and units that stopped awaiting a human
 * go again: an esp-ship unit resumes, a wait restarts with a new deadline.
 * Their blocked dependents become pending. A run stopped before its graph
 * was recorded or approved has nothing to resume: `next` picks it up.
 */
export function cmdResume(options, env = process.env) {
  const dir = runDirOf(options);
  const state = readState(dir);
  const graph = readGraph(dir);
  if (!graph || state.phase === "intake" || state.phase === "approve")
    return {
      phase: state.phase,
      resumed: [],
      restarted: [],
      unblocked: [],
      reason: `Nothing to resume in phase ${state.phase}`
    };
  const byId = new Map(graph.units.map((u) => [u.id, u]));
  return updateState(
    dir,
    (s) => {
      const at = now(env).toISOString();
      const resumed = [];
      const restarted = [];
      for (const id of topoOrder(graph)) {
        const unit = byId.get(id);
        const entry = s.units[id];
        const wait = s.waits[id];
        if (entry.status === "running") {
          entry.resume = true;
          resumed.push(id);
        } else if (entry.status === "waiting" && wait) {
          wait.restart = true;
          restarted.push(id);
        } else if (entry.status === "awaiting-human") {
          entry.reason = null;
          entry.question = null;
          entry.ended_at = null;
          if (isWaitUnit(unit, entry) && wait) {
            entry.status = "waiting";
            Object.assign(wait, {
              status: "started",
              restart: true,
              ended_at: null
            });
            restarted.push(id);
          } else if (entry.run_dir) {
            entry.status = "running";
            entry.resume = true;
            resumed.push(id);
          } else entry.status = "pending";
        }
      }
      const unblocked = refreshBlocked(s, graph, at).filter(
        (id) => s.units[id].status === "pending"
      );
      if (s.phase === "done") s.phase = "run";
      return { phase: s.phase, resumed, restarted, unblocked };
    },
    env
  );
}

/** The outcome of the run; marks the run done once every unit is terminal. */
export function cmdOutcome(options, env = process.env) {
  const dir = runDirOf(options);
  const state = readState(dir);
  const graph = readGraph(dir);
  const outcome = outcomeOf(state, graph, dir);
  if (outcome.finished && state.phase !== "done")
    updateState(
      dir,
      (s) => {
        s.phase = "done";
      },
      env
    );
  return outcome;
}
