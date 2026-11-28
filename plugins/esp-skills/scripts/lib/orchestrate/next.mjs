// esp-orchestrate scheduling: the single next action, the payload of each
// action, the unit mode, and the outcome of the run.
//
// nextAction reads orchestrate.json and graph.json and never writes, so the
// same files always give the same action. Priority: intake (no graph),
// checkpoint (plan approval, then before each unit with -i all), housekeep (a
// merged unit not housekept), spawn-unit or run-unit-inline (a unit to resume,
// then a ready build, adopt, or await-pr whose wait found a pull request),
// start-wait (a wait to restart, then a ready check or await-pr), idle (units
// or waits still running), finish (every unit terminal).
//
// Readiness: a unit is ready when every dependency is merged or done. A
// pending unit with a failed, awaiting-human, halted or blocked dependency is
// blocked. At most max_parallel units or waits run at once, and never two
// units with the same repo_dir. A unit marked for resume holds its slot and
// its checkout until it is relaunched, and relaunches only when its checkout
// is free and a slot is left among the units and waits already live.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, runDirOf } from "../ship/state.mjs";
import { PR_KINDS, topoOrder } from "./graph.mjs";
import { readGraph, readState } from "./state.mjs";

/** The scripts directory of the plugin (wait-for.mjs, housekeep.mjs). */
export const SCRIPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
/** Bare skill names: the per-harness invocation syntax belongs in the README. */
export const SHIP_SKILL = "esp-ship";
export const ORCHESTRATE_SKILL = "esp-orchestrate";
/** Unit statuses that count as landed. */
export const LANDED = new Set(["merged", "done"]);
/** Unit statuses that stop the unit and block its dependents. */
export const STOPPED = new Set([
  "failed",
  "awaiting-human",
  "halted",
  "blocked"
]);
export const TERMINAL = new Set([...LANDED, ...STOPPED]);
export const ACTIVE = new Set(["running", "waiting"]);
/**
 * Spawn depth a unit subagent needs: the unit (1), its builder or verifier
 * (2) and their relay (3). Below it, units run inline.
 */
export const SUBAGENT_DEPTH = 3;

export const unitRunDir = (runDir, id) => join(runDir, "units", id);
export const waitStatePath = (runDir, id) =>
  join(runDir, "waits", `${id}.json`);
export const resumeCommand = (runDir) =>
  `${ORCHESTRATE_SKILL} --resume --run-dir ${quoteArg(runDir)}`;

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/** One argument for a POSIX shell: bare when safe, else single-quoted. */
export function quoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/.,:=@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

export const quoteArgs = (args) => args.map(quoteArg).join(" ");

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

const unitsById = (graph) => new Map(graph.units.map((u) => [u.id, u]));

/**
 * The status of every unit, in dependency order: the recorded status, except
 * a pending unit with a stopped dependency, which is blocked.
 */
export function effectiveStatuses(state, graph) {
  const byId = unitsById(graph);
  const out = {};
  for (const id of topoOrder(graph)) {
    const status = state.units[id]?.status ?? "pending";
    const stopped = byId
      .get(id)
      .depends_on.some((dep) => STOPPED.has(out[dep]));
    out[id] = status === "pending" && stopped ? "blocked" : status;
  }
  return out;
}

/** The first dependency of a unit that stopped, or null. */
export function stoppedDependency(unit, statuses) {
  const dep = unit.depends_on.find((d) => STOPPED.has(statuses[d]));
  return dep ? { id: dep, status: statuses[dep] } : null;
}

export const isReady = (unit, statuses) =>
  unit.depends_on.every((dep) => LANDED.has(statuses[dep]));

/** A unit that runs as a wait: a check, or an await-pr with no pull request yet. */
export const isWaitUnit = (unit, entry) =>
  unit.kind === "check" || (unit.kind === "await-pr" && !entry?.pr);

/** A comparable form of a checkout path. */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) =>
    process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  return norm(a) === norm(b);
}

/** A running unit marked for resume, not relaunched yet. */
export const awaitsRelaunch = (entry) =>
  entry?.status === "running" && entry.resume === true;

/**
 * The checkouts of the esp-ship units running now. With `live`, only the
 * units already relaunched: a unit awaiting relaunch is left out.
 */
function busyRepos(state, graph, { live = false } = {}) {
  return graph.units
    .filter(
      (u) =>
        u.repo_dir &&
        PR_KINDS.includes(u.kind) &&
        state.units[u.id]?.status === "running" &&
        !(live && awaitsRelaunch(state.units[u.id]))
    )
    .map((u) => u.repo_dir);
}

// ---------------------------------------------------------------------------
// Unit mode
// ---------------------------------------------------------------------------

function spawnDepth(env) {
  const raw = env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/**
 * How a unit runs: a spawn depth below SUBAGENT_DEPTH always gives inline;
 * otherwise the recorded or configured mode, and for auto: inline with
 * -i all or for the last unit left, else subagent.
 */
export function resolveMode(state, unitId, env, statuses, recorded = null) {
  const depth = spawnDepth(env);
  if (depth !== null && depth < SUBAGENT_DEPTH)
    return {
      mode: "inline",
      reason: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH is ${depth}: a unit subagent needs ${SUBAGENT_DEPTH} levels`
    };
  if (recorded)
    return { mode: recorded, reason: `the mode the unit started with` };
  const configured = state.settings.unit_mode;
  if (configured !== "auto")
    return { mode: configured, reason: `unit mode ${configured}` };
  if (state.interactive === "all")
    return {
      mode: "inline",
      reason: "-i all: esp-ship asks its own checkpoints in this session"
    };
  const others = Object.entries(statuses).filter(
    ([id, status]) => id !== unitId && !TERMINAL.has(status)
  );
  if (others.length === 0)
    return { mode: "inline", reason: "the last unit left" };
  return { mode: "subagent", reason: "unit mode auto" };
}

// ---------------------------------------------------------------------------
// Action payloads
// ---------------------------------------------------------------------------

const shipStateOf = (unitDir) => {
  const path = join(unitDir, "ship.json");
  if (!existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return null;
  }
};

/** The esp-ship arguments of a unit. */
export function shipArgs(unit, entry, { runDir, interactive, resume }) {
  const args = resume ? ["--resume"] : [];
  args.push(
    "--run-dir",
    unitRunDir(runDir, unit.id),
    "--parent-run",
    runDir,
    "--project-dir",
    unit.repo_dir,
    "--interactive",
    interactive
  );
  if (resume) return args;
  const s = unit.settings;
  if (unit.kind === "adopt") args.push("--pr", unit.pr);
  else if (unit.kind === "await-pr") args.push("--pr", entry.pr);
  else if (unit.plan === "master") args.push("--plan-mode", "skip");
  args.push("--merge-policy", s.merge, "--checks", s.checks);
  if (s.review) args.push("--review", s.review);
  args.push("--max-rounds", String(s.max_rounds));
  if (s.reviewers.length > 0) args.push("--reviewers", s.reviewers.join(","));
  if (unit.kind === "build") {
    if (s.draft) args.push("--draft");
    if (s.branch) args.push("--branch", s.branch);
    args.push(unit.plan === "master" ? unit.plan_path : unit.brief);
  }
  return args;
}

/** spawn-unit or run-unit-inline for a unit to start or resume. */
export function spawnAction(state, unit, { runDir, env, statuses }) {
  const entry = state.units[unit.id];
  const resuming = entry.status === "running" && entry.resume === true;
  const { mode, reason } = resolveMode(
    state,
    unit.id,
    env,
    statuses,
    resuming ? entry.mode : null
  );
  const runPath = unitRunDir(runDir, unit.id);
  // esp-ship --resume needs the ship.json of the unit run: a unit stopped
  // before esp-ship initialized starts over in the same run directory.
  const resume = resuming && existsSync(join(runPath, "ship.json"));
  const interactive =
    mode === "inline" && state.interactive === "all" ? "all" : "off";
  const args = shipArgs(unit, entry, { runDir, interactive, resume });
  const argString = quoteArgs(args);
  return {
    action: mode === "inline" ? "run-unit-inline" : "spawn-unit",
    unit: unit.id,
    kind: unit.kind,
    title: unit.title,
    repo: unit.repo,
    project_dir: unit.repo_dir,
    run_dir: runPath,
    parent_run: runDir,
    mode,
    mode_reason: reason,
    resume,
    pr: unit.kind === "adopt" ? unit.pr : (entry.pr ?? null),
    brief: unit.brief,
    skill: SHIP_SKILL,
    args,
    arguments: argString,
    invoke: `${SHIP_SKILL} ${argString}`,
    start: `unit start ${unit.id} --mode ${mode}`
  };
}

/** The wait-for.mjs arguments of a check or await-pr unit. */
export function waitArgs(unit, runDir) {
  const args = [];
  if (unit.kind === "check") {
    args.push("command", "--run", unit.command);
    const cwd = unit.cwd ?? unit.repo_dir;
    if (cwd) args.push("--cwd", cwd);
  } else {
    args.push("pr", "--repo", unit.repo);
    for (const key of ["head", "author", "base", "title"])
      if (unit.match?.[key]) args.push(`--${key}`, unit.match[key]);
  }
  args.push("--state", waitStatePath(runDir, unit.id), "--run-dir", runDir);
  if (unit.settings.timeout_minutes)
    args.push("--timeout-minutes", String(unit.settings.timeout_minutes));
  return args;
}

/** start-wait for a check or await-pr unit, new or restarted. */
export function waitAction(unit, { runDir, restart }) {
  const script = join(SCRIPTS_DIR, "wait-for.mjs");
  const args = waitArgs(unit, runDir);
  return {
    action: "start-wait",
    unit: unit.id,
    kind: unit.kind,
    title: unit.title,
    wait: unit.kind === "check" ? "command" : "pr",
    restart,
    state_file: waitStatePath(runDir, unit.id),
    script,
    args,
    command: `node ${quoteArg(script)} ${quoteArgs(args)}`,
    start: `wait start ${unit.id}`,
    record: `wait record ${unit.id} --result <json|file>`
  };
}

/** Branches of the later unstarted build units in the same checkout. */
export function rebaseTargets(unit, graph, statuses, { base, branch }) {
  const out = [];
  for (const other of graph.units) {
    const b = other.settings?.branch;
    if (
      other.id === unit.id ||
      other.kind !== "build" ||
      statuses[other.id] !== "pending" ||
      !b ||
      b === branch ||
      b === base ||
      !samePath(other.repo_dir, unit.repo_dir) ||
      out.includes(b)
    )
      continue;
    out.push(b);
  }
  return out;
}

/** housekeep for a merged unit: the housekeep.mjs run arguments. */
export function housekeepAction(state, unit, graph, statuses, runDir) {
  const entry = state.units[unit.id];
  const ship = shipStateOf(entry.run_dir ?? unitRunDir(runDir, unit.id));
  const base = ship?.base ?? null;
  const branch = ship?.branch ?? null;
  const pr = entry.pr ?? ship?.pr ?? unit.pr ?? null;
  const script = join(SCRIPTS_DIR, "housekeep.mjs");
  const out = {
    action: "housekeep",
    unit: unit.id,
    repo: unit.repo,
    repo_dir: unit.repo_dir,
    base,
    branch,
    pr,
    script,
    record: `housekeep --unit ${unit.id} --result <json|file>`
  };
  if (!base)
    return {
      ...out,
      args: null,
      command: null,
      rebase: [],
      skip: `The base branch of unit ${unit.id} is unknown (no base in its ship.json): record a skipped result`
    };
  const rebase = rebaseTargets(unit, graph, statuses, { base, branch });
  const args = ["run", "--repo-dir", unit.repo_dir, "--base", base];
  if (branch && pr) args.push("--branch", branch, "--pr", pr);
  if (ship?.worktree) args.push("--worktree", ship.worktree);
  for (const b of rebase) args.push("--rebase", b);
  return {
    ...out,
    rebase,
    args,
    command: `node ${quoteArg(script)} ${quoteArgs(args)}`
  };
}

// ---------------------------------------------------------------------------
// next
// ---------------------------------------------------------------------------

function approvalCheckpoint(state, graph, runDir) {
  return {
    action: "checkpoint",
    kind: "approve-plan",
    graph_path: state.graph_path,
    plan_path: join(runDir, "plan.md"),
    units: graph.units.map((u) => ({
      id: u.id,
      kind: u.kind,
      repo: u.repo,
      depends_on: u.depends_on,
      plan: u.plan,
      merge: PR_KINDS.includes(u.kind) ? u.settings.merge : null
    })),
    then: "approve"
  };
}

/**
 * The single next action of the run. `env` supplies
 * CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH; `runDir` defaults to the directory
 * of the recorded graph.
 */
export function nextAction(state, graph, env = {}, { runDir } = {}) {
  if (!graph || state.phase === "intake")
    return {
      action: "intake",
      reason:
        "No task graph recorded: write the master plan and the graph, then intake --record"
    };
  const dir = runDir ?? dirname(state.graph_path);
  if (state.interactive !== "off" && !state.approved)
    return approvalCheckpoint(state, graph, dir);

  const byId = unitsById(graph);
  const order = topoOrder(graph);
  const statuses = effectiveStatuses(state, graph);
  const entry = (id) => state.units[id] ?? { status: "pending" };
  const busy = busyRepos(state, graph);

  if (state.settings.housekeeping)
    for (const id of order) {
      const unit = byId.get(id);
      if (
        statuses[id] === "merged" &&
        !entry(id).housekept &&
        unit.repo_dir &&
        !busy.some((d) => samePath(d, unit.repo_dir))
      )
        return housekeepAction(state, unit, graph, statuses, dir);
    }

  const live = order.filter(
    (id) => ACTIVE.has(statuses[id]) && !awaitsRelaunch(entry(id))
  );
  if (live.length < state.settings.max_parallel) {
    const liveBusy = busyRepos(state, graph, { live: true });
    for (const id of order) {
      const unit = byId.get(id);
      if (
        awaitsRelaunch(entry(id)) &&
        !liveBusy.some((d) => samePath(d, unit.repo_dir))
      )
        return spawnAction(state, unit, { runDir: dir, env, statuses });
    }
  }
  for (const id of order) {
    const e = entry(id);
    if (e.status === "waiting" && state.waits[id]?.restart === true)
      return waitAction(byId.get(id), { runDir: dir, restart: true });
  }

  const active = order.filter((id) => ACTIVE.has(statuses[id]));
  const capacity = state.settings.max_parallel - active.length;
  const ready = order.filter(
    (id) => statuses[id] === "pending" && isReady(byId.get(id), statuses)
  );
  if (capacity > 0) {
    for (const id of ready) {
      const unit = byId.get(id);
      if (!PR_KINDS.includes(unit.kind) || isWaitUnit(unit, entry(id)))
        continue;
      if (!unit.repo_dir)
        return {
          action: "checkpoint",
          kind: "unresolved-repo",
          unit: id,
          repo: unit.repo,
          reason: `Unit ${id} is ready but no checkout of ${unit.repo} is known: add it to orchestrate.repos or clone it, or stop the unit with unit failed`
        };
      if (busy.some((d) => samePath(d, unit.repo_dir))) continue;
      const action = spawnAction(state, unit, { runDir: dir, env, statuses });
      if (state.interactive === "all")
        return {
          action: "checkpoint",
          kind: "before-unit",
          unit: id,
          title: unit.title,
          then: action
        };
      return action;
    }
    for (const id of ready) {
      const unit = byId.get(id);
      if (isWaitUnit(unit, entry(id)))
        return waitAction(unit, { runDir: dir, restart: false });
    }
  }

  if (order.every((id) => TERMINAL.has(statuses[id])))
    return {
      action: "finish",
      status: runStatus(statuses),
      then: "outcome"
    };
  return {
    action: "idle",
    running: order.filter((id) => statuses[id] === "running"),
    waiting: order.filter((id) => statuses[id] === "waiting"),
    reason:
      active.length > 0
        ? "Units or waits are running: end the turn and wait for their notification"
        : "No unit can start and none is running"
  };
}

export function cmdNext(options, env = process.env) {
  const dir = runDirOf(options);
  const state = readState(dir);
  return nextAction(state, readGraph(dir), env, { runDir: dir });
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** The run status once every unit is terminal. */
export function runStatus(statuses) {
  const values = Object.values(statuses);
  const landed = values.filter((s) => LANDED.has(s)).length;
  if (landed === values.length) return "merged";
  if (landed > 0) return "partial";
  if (values.includes("halted")) return "halted";
  if (values.includes("awaiting-human")) return "awaiting-human";
  return "failed";
}

/**
 * The outcome of the run: its status (running until every unit is
 * terminal), one entry per unit, the dirty checkouts and other housekeeping
 * issues, and the command that resumes the run.
 */
export function outcomeOf(state, graph, runDir) {
  if (!graph)
    return {
      status: "running",
      finished: false,
      request: state.request,
      units: [],
      counts: {},
      dirty: [],
      housekeeping_issues: [],
      summary: "No task graph recorded yet",
      resume: resumeCommand(runDir)
    };
  const byId = unitsById(graph);
  const order = topoOrder(graph);
  const statuses = effectiveStatuses(state, graph);
  const units = order.map((id) => {
    const unit = byId.get(id);
    const e = state.units[id] ?? {};
    const status = statuses[id];
    const dep = status === "blocked" ? stoppedDependency(unit, statuses) : null;
    return {
      id,
      kind: unit.kind,
      title: unit.title,
      repo: unit.repo,
      status,
      pr: e.pr ?? unit.pr ?? null,
      merge_commit: e.merge_commit ?? null,
      reason:
        e.reason ?? (dep ? `dependency ${dep.id} is ${dep.status}` : null),
      question: e.question ?? null,
      run_dir: e.run_dir ?? null,
      housekeeping: e.housekeeping?.status ?? null
    };
  });
  const finished = units.every((u) => TERMINAL.has(u.status));
  const counts = {};
  for (const u of units) counts[u.status] = (counts[u.status] ?? 0) + 1;
  const dirty = [];
  const issues = [];
  for (const id of order) {
    const h = state.units[id]?.housekeeping;
    if (!h) continue;
    const repoDir = byId.get(id).repo_dir;
    if (h.status === "skipped" && h.reason === "dirty")
      dirty.push({ unit: id, repo_dir: repoDir, files: h.files ?? [] });
    else if (h.status === "partial" || h.status === "failed")
      issues.push({
        unit: id,
        repo_dir: repoDir,
        status: h.status,
        summary: h.summary
      });
  }
  const landed = units.filter((u) => LANDED.has(u.status)).length;
  const stopped = units
    .filter((u) => STOPPED.has(u.status))
    .map((u) => `${u.id} ${u.status}`);
  return {
    status: finished ? runStatus(statuses) : "running",
    finished,
    request: state.request,
    units,
    counts,
    dirty,
    housekeeping_issues: issues,
    summary: `${landed} of ${units.length} units landed${stopped.length > 0 ? `; stopped: ${stopped.join(", ")}` : ""}`,
    resume: resumeCommand(runDir)
  };
}
