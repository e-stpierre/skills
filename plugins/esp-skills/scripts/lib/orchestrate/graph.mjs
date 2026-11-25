// esp-orchestrate task graph: validation, order, defaults and repository
// resolution of the units of graph.json.
//
// A unit is one node of the graph: `build` (a change shipped as a new pull
// request), `adopt` (an open pull request taken over), `await-pr` (a pull
// request waited for, then adopted) or `check` (a command polled until it
// succeeds). validateGraph returns every error at once, so intake can report
// them together and write nothing.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandHome } from "../../config.mjs";
import { appendDecision } from "../../runs.mjs";
import { REVIEW_MODES } from "../ship/review-gate.mjs";
import {
  CHECKS_MODES,
  configOf,
  MERGE_POLICIES,
  readJson,
  runDirOf,
  stringOption
} from "../ship/state.mjs";
import {
  newUnitEntry,
  OrchestrateError,
  readState,
  updateState,
  writeGraph
} from "./state.mjs";

export const UNIT_KINDS = ["build", "adopt", "await-pr", "check"];
/** Kinds that run through esp-ship and so need a repository. */
export const PR_KINDS = ["build", "adopt", "await-pr"];
export const UNIT_ROLES = ["code", "write-back"];
export const PLAN_SOURCES = ["master", "self"];
export const SETTING_KEYS = [
  "merge",
  "review",
  "reviewers",
  "max_rounds",
  "draft",
  "branch",
  "checks",
  "timeout_minutes"
];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_URL = /^https?:\/\/[^\s/]+\/([^\s/]+\/[^\s/]+)\/pull\/\d+\/?$/;

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const show = (v) => (v === undefined ? "undefined" : JSON.stringify(v));

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function checkSettings(settings, where, fail) {
  if (settings === undefined || settings === null) return;
  if (!isObject(settings)) {
    fail(`${where}.settings: expected an object`);
    return;
  }
  for (const key of Object.keys(settings))
    if (!SETTING_KEYS.includes(key))
      fail(
        `${where}.settings.${key}: unknown setting (expected ${SETTING_KEYS.join(", ")})`
      );
  const enumOf = (key, list) => {
    const v = settings[key];
    if (v !== undefined && v !== null && !list.includes(v))
      fail(
        `${where}.settings.${key}: expected one of ${list.join(", ")}, got ${show(v)}`
      );
  };
  enumOf("merge", MERGE_POLICIES);
  enumOf("review", REVIEW_MODES);
  enumOf("checks", CHECKS_MODES);
  const { reviewers, max_rounds, draft, branch, timeout_minutes } = settings;
  if (
    reviewers !== undefined &&
    reviewers !== null &&
    !(Array.isArray(reviewers) && reviewers.every(isText))
  )
    fail(`${where}.settings.reviewers: expected a list of names`);
  for (const [key, v] of [
    ["max_rounds", max_rounds],
    ["timeout_minutes", timeout_minutes]
  ])
    if (v !== undefined && v !== null && !(Number.isInteger(v) && v >= 1))
      fail(
        `${where}.settings.${key}: expected an integer >= 1, got ${show(v)}`
      );
  if (draft !== undefined && draft !== null && typeof draft !== "boolean")
    fail(`${where}.settings.draft: expected a boolean, got ${show(draft)}`);
  if (branch !== undefined && branch !== null && !isText(branch))
    fail(`${where}.settings.branch: expected a branch name or null`);
}

function checkKindFields(unit, where, fail) {
  switch (unit.kind) {
    case "build":
      if (!isText(unit.brief)) fail(`${where}: a build unit needs a brief`);
      break;
    case "adopt": {
      const m = PR_URL.exec(typeof unit.pr === "string" ? unit.pr : "");
      if (!m) fail(`${where}: an adopt unit needs a pull request URL in pr`);
      else if (
        REPO_PATTERN.test(String(unit.repo)) &&
        m[1].toLowerCase() !== String(unit.repo).toLowerCase()
      )
        fail(`${where}: pr ${unit.pr} is not a pull request of ${unit.repo}`);
      break;
    }
    case "await-pr": {
      const match = unit.match;
      if (!isObject(match) || !(isText(match.head) || isText(match.author)))
        fail(`${where}: an await-pr unit needs match.head or match.author`);
      else {
        for (const key of ["head", "author", "base", "title"])
          if (
            match[key] !== undefined &&
            match[key] !== null &&
            !isText(match[key])
          )
            fail(`${where}.match.${key}: expected a non-empty string`);
        if (isText(match.title))
          try {
            new RegExp(match.title);
          } catch (err) {
            fail(
              `${where}.match.title: invalid regular expression (${err.message})`
            );
          }
      }
      break;
    }
    case "check":
      if (!isText(unit.command)) fail(`${where}: a check unit needs a command`);
      if (unit.cwd !== undefined && unit.cwd !== null && !isText(unit.cwd))
        fail(`${where}.cwd: expected a directory or null`);
      break;
  }
}

/** Every cycle of the dependency edges, each as a list of IDs (first repeated last). */
export function findCycles(units) {
  const deps = new Map(
    units.map((u) => [u.id, (u.depends_on ?? []).filter((d) => d !== u.id)])
  );
  const color = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();
  const visit = (id) => {
    color.set(id, "gray");
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue;
      if (color.get(dep) === "gray") {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        const key = [...new Set(cycle)].sort().join("\n");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!color.has(dep)) visit(dep);
    }
    stack.pop();
    color.set(id, "black");
  };
  for (const id of deps.keys()) if (!color.has(id)) visit(id);
  return cycles;
}

/**
 * Check a task graph; returns every error as a string (empty when valid):
 * unique IDs, known kinds, depends_on targets, cycles, owner/name
 * repositories, the fields of each kind and the setting enums.
 */
export function validateGraph(graph) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!isObject(graph)) return ["graph: expected an object with a units list"];
  if (graph.graph_format !== undefined && graph.graph_format !== 1)
    fail(`graph_format: expected 1, got ${show(graph.graph_format)}`);
  if (!Array.isArray(graph.units) || graph.units.length === 0)
    return [...errors, "units: expected a non-empty list"];
  const ids = new Set();
  const valid = [];
  graph.units.forEach((unit, i) => {
    if (!isObject(unit)) {
      fail(`units[${i}]: expected an object`);
      return;
    }
    const where =
      typeof unit.id === "string" ? `unit ${unit.id}` : `units[${i}]`;
    if (typeof unit.id !== "string" || !ID_PATTERN.test(unit.id))
      fail(
        `${where}: id must be letters, digits, dot, underscore or dash, got ${show(unit.id)}`
      );
    else if (ids.has(unit.id)) fail(`${where}: duplicate id`);
    else {
      ids.add(unit.id);
      valid.push(unit);
    }
    if (!UNIT_KINDS.includes(unit.kind))
      fail(
        `${where}.kind: expected one of ${UNIT_KINDS.join(", ")}, got ${show(unit.kind)}`
      );
    const needsRepo = PR_KINDS.includes(unit.kind);
    if (unit.repo === undefined || unit.repo === null) {
      if (needsRepo) fail(`${where}.repo: required (owner/name)`);
    } else if (typeof unit.repo !== "string" || !REPO_PATTERN.test(unit.repo))
      fail(`${where}.repo: expected owner/name, got ${show(unit.repo)}`);
    if (
      unit.repo_dir !== undefined &&
      unit.repo_dir !== null &&
      !isText(unit.repo_dir)
    )
      fail(`${where}.repo_dir: expected a path or null`);
    if (unit.title !== undefined && unit.title !== null && !isText(unit.title))
      fail(`${where}.title: expected a non-empty string`);
    if (unit.depends_on !== undefined && !Array.isArray(unit.depends_on))
      fail(`${where}.depends_on: expected a list of unit IDs`);
    if (
      unit.role !== undefined &&
      unit.role !== null &&
      !UNIT_ROLES.includes(unit.role)
    )
      fail(
        `${where}.role: expected one of ${UNIT_ROLES.join(", ")}, got ${show(unit.role)}`
      );
    if (
      unit.plan !== undefined &&
      unit.plan !== null &&
      !PLAN_SOURCES.includes(unit.plan)
    )
      fail(
        `${where}.plan: expected one of ${PLAN_SOURCES.join(", ")}, got ${show(unit.plan)}`
      );
    if (
      unit.plan_path !== undefined &&
      unit.plan_path !== null &&
      !isText(unit.plan_path)
    )
      fail(`${where}.plan_path: expected a path or null`);
    checkKindFields(unit, where, fail);
    checkSettings(unit.settings, where, fail);
  });
  for (const unit of graph.units) {
    if (!isObject(unit) || !Array.isArray(unit.depends_on)) continue;
    for (const dep of unit.depends_on) {
      if (dep === unit.id)
        fail(`unit ${unit.id}.depends_on: depends on itself`);
      else if (!ids.has(dep))
        fail(`unit ${unit.id}.depends_on: unknown unit ${show(dep)}`);
    }
  }
  for (const cycle of findCycles(
    valid.map((u) => ({
      id: u.id,
      depends_on: Array.isArray(u.depends_on) ? u.depends_on : []
    }))
  ))
    fail(`cycle: ${cycle.join(" -> ")}`);
  return errors;
}

/**
 * Unit IDs in dependency order; among the units ready at the same time, the
 * graph order is kept.
 */
export function topoOrder(graph) {
  const units = graph.units;
  const pending = new Map(
    units.map((u) => [u.id, new Set(u.depends_on ?? [])])
  );
  const order = [];
  while (pending.size > 0) {
    const ready = units.find(
      (u) =>
        pending.has(u.id) &&
        [...pending.get(u.id)].every((d) => !pending.has(d))
    );
    if (!ready)
      throw new OrchestrateError(
        `The graph has a cycle among ${[...pending.keys()].join(", ")}`
      );
    order.push(ready.id);
    pending.delete(ready.id);
  }
  return order;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The canonical form of a valid unit, in the graph.json field order, with
 * the run defaults (merge policy, max rounds) filling its settings.
 */
export function normalizeUnit(unit, { runDir, mergePolicy, maxRounds }) {
  const build = unit.kind === "build";
  const plan = build ? (unit.plan ?? "self") : null;
  const s = unit.settings ?? {};
  return {
    id: unit.id,
    kind: unit.kind,
    title: unit.title ?? unit.id,
    repo: unit.repo ?? null,
    repo_dir: unit.repo_dir ?? null,
    depends_on: [...(unit.depends_on ?? [])],
    role: unit.role ?? "code",
    plan,
    plan_path:
      plan === "master"
        ? (unit.plan_path ?? join(runDir, "plans", `${unit.id}.md`))
        : (unit.plan_path ?? null),
    brief: unit.brief ?? null,
    settings: {
      merge: s.merge ?? mergePolicy,
      review: s.review ?? null,
      reviewers: s.reviewers ?? [],
      max_rounds: s.max_rounds ?? maxRounds,
      draft: s.draft ?? false,
      branch: s.branch ?? null,
      checks: s.checks ?? "required",
      timeout_minutes: s.timeout_minutes ?? null
    },
    pr: unit.pr ?? null,
    match: unit.match ?? null,
    command: unit.command ?? null,
    cwd: unit.cwd ?? null
  };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/** owner/name of a GitHub remote URL (HTTPS or SSH), or null. */
export function repoOfRemote(url) {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)[^/:\s]+(?::\d+)?[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(
      String(url ?? "").trim()
    );
  return m ? m[1] : null;
}

function originOf(dir) {
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
    encoding: "utf8",
    windowsHide: true
  });
  return r.status === 0 ? repoOfRemote(r.stdout) : null;
}

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Candidate checkouts near projectDir: projectDir itself, then its sibling
 * directories (in name order) that hold a .git entry.
 */
function candidateDirs(projectDir) {
  const parent = dirname(projectDir);
  let siblings = [];
  try {
    siblings = readdirSync(parent)
      .sort()
      .map((name) => join(parent, name))
      .filter((dir) => dir !== projectDir && isDir(dir));
  } catch {
    siblings = [];
  }
  return [projectDir, ...siblings].filter((dir) =>
    existsSync(join(dir, ".git"))
  );
}

/**
 * Resolve the checkout of every unit repository: a repo_dir given in the
 * graph, else orchestrate.repos (owner/name -> path), else projectDir or a
 * sibling directory whose origin URL names owner/name (HTTPS or SSH).
 * Returns { units, unresolved }: units are copies with repo_dir and
 * repo_source set; unresolved lists { id, repo } of units left with
 * repo_dir null.
 */
export function resolveRepos(graph, { repos = {}, projectDir = null } = {}) {
  const configured = new Map(
    Object.entries(repos ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  let origins = null;
  const scan = () => {
    if (origins) return origins;
    origins = [];
    if (projectDir)
      for (const dir of candidateDirs(resolve(projectDir))) {
        const repo = originOf(dir);
        if (repo) origins.push({ dir, repo: repo.toLowerCase() });
      }
    return origins;
  };
  const units = [];
  const unresolved = [];
  for (const unit of graph.units) {
    let repoDir = null;
    let source = null;
    if (unit.repo_dir) {
      repoDir = resolve(expandHome(unit.repo_dir));
      source = "graph";
    } else if (unit.repo) {
      const key = unit.repo.toLowerCase();
      if (configured.has(key)) {
        repoDir = resolve(expandHome(configured.get(key)));
        source = "config";
      } else {
        const found = scan().find((o) => o.repo === key);
        if (found) {
          repoDir = found.dir;
          source = found.dir === resolve(projectDir) ? "project" : "sibling";
        }
      }
    }
    units.push({ ...unit, repo_dir: repoDir, repo_source: source });
    if (unit.repo && !repoDir)
      unresolved.push({ id: unit.id, repo: unit.repo });
  }
  return { units, unresolved };
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

const SIZING = {
  master: {
    decision: (id) => `Plan unit ${id} in the master plan`,
    rationale:
      "Small unit: the master plan holds its full plan, so its esp-ship run skips planning (--plan-mode skip)",
    alternatives: ["Let the unit's esp-ship run plan itself"]
  },
  self: {
    decision: (id) => `Let unit ${id} plan itself`,
    rationale:
      "Large unit: the master plan holds only its brief, and its esp-ship run writes its own plan",
    alternatives: ["Hold the unit's full plan in the master plan"]
  }
};

const MERGE_RATIONALE = {
  human:
    "Set by the request or the plan approval: the pull request waits for someone else to merge it",
  none: "Set by the request or the plan approval: the pull request is left open, unmerged"
};

/** The decisions of an intake: one per sizing choice, one per non-auto merge. */
function intakeDecisions(units) {
  const out = [];
  for (const unit of units) {
    if (unit.kind === "build") {
      const sizing = SIZING[unit.plan];
      out.push({
        phase: "intake",
        source: "agent",
        risk: "low",
        decision: sizing.decision(unit.id),
        rationale: sizing.rationale,
        alternatives: sizing.alternatives,
        refs: [unit.id]
      });
    }
    if (unit.settings.merge !== "auto" && PR_KINDS.includes(unit.kind))
      out.push({
        phase: "intake",
        source: "agent",
        risk: "low",
        decision: `Merge policy ${unit.settings.merge} for unit ${unit.id}`,
        rationale: MERGE_RATIONALE[unit.settings.merge],
        alternatives: ["auto: esp-merge merges the pull request"],
        refs: [unit.id]
      });
  }
  return out;
}

/**
 * intake --graph <file> [--record]: validate the graph, fill the unit
 * defaults from the run, resolve every repository and compute the order.
 * With --record, write graph.json, reset every unit to pending, move the run
 * to approve (run with -i off) and log the intake decisions. An invalid
 * graph exits 1 and writes nothing. A graph is recorded again only while
 * every unit is still pending.
 */
export function cmdIntake(options, env = process.env) {
  const dir = runDirOf(options);
  const file = stringOption(options.graph);
  if (!file) throw new OrchestrateError("intake needs --graph <file>", 2);
  const state = readState(dir);
  const input = readJson(resolve(expandHome(file)));
  const errors = validateGraph(input);
  if (errors.length > 0)
    throw new OrchestrateError(
      `Invalid graph ${file} (${errors.length} error${errors.length === 1 ? "" : "s"}):\n  ${errors.join("\n  ")}`
    );
  const started = Object.entries(state.units)
    .filter(([, u]) => u.status !== "pending")
    .map(([id]) => id);
  if (options.record && started.length > 0)
    throw new OrchestrateError(
      `The graph is already running (units ${started.join(", ")}): intake records a graph only before any unit starts`
    );
  const normalized = input.units.map((unit) =>
    normalizeUnit(unit, {
      runDir: dir,
      mergePolicy: state.settings.merge_policy,
      maxRounds: state.settings.max_rounds
    })
  );
  const config = configOf(state.config_snapshot);
  const resolved = resolveRepos(
    { units: normalized },
    { repos: config.orchestrate?.repos ?? {}, projectDir: state.project_dir }
  );
  const units = resolved.units.map(({ repo_source, ...unit }) => unit);
  const order = topoOrder({ units });
  const phase = state.interactive === "off" ? "run" : "approve";
  const summary = resolved.units.map((u) => ({
    id: u.id,
    kind: u.kind,
    repo: u.repo,
    repo_dir: u.repo_dir,
    repo_source: u.repo_source,
    depends_on: u.depends_on,
    plan: u.plan,
    merge: PR_KINDS.includes(u.kind) ? u.settings.merge : null
  }));
  const decisions = intakeDecisions(units);
  if (!options.record)
    return {
      recorded: false,
      units: summary,
      order,
      unresolved: resolved.unresolved,
      decisions: decisions.map((d) => d.decision)
    };
  const path = writeGraph(dir, { units });
  updateState(
    dir,
    (s) => {
      s.units = Object.fromEntries(units.map((u) => [u.id, newUnitEntry()]));
      s.graph_path = path;
      s.phase = phase;
      s.approved = false;
    },
    env
  );
  const logged = decisions.map((d) => appendDecision(dir, d, env));
  return {
    recorded: true,
    graph_path: path,
    phase,
    units: summary,
    order,
    unresolved: resolved.unresolved,
    decisions: logged.map((d) => ({ id: d.id, decision: d.decision }))
  };
}
