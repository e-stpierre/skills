#!/usr/bin/env node
// esp-recap: read run directories and give the skill compact, sourced data.
//
// The skill never opens run files by hand to decide what to read. This script
// lists the runs in range (through runs.mjs indexRuns), reads their summary
// frontmatter, decisions and step records, and returns JSON with the path of
// every artifact it used, so each statement in a recap can cite its source.
//
// Commands: collect (recap mode), show (one run in full, used by fan-out
// subagents), risks (risk report), sources (Q&A candidates, in the source
// order decisions -> summaries -> git -> pull requests).
// Child runs (esp-orchestrate units under units/<id>, overseer tasks under
// tasks/<id>) are nested under their parent run in collect and show, and their
// decisions and findings carry the parent ID in risks and sources.
// ESP_RUNS_NOW (ISO date-time) fixes the clock, for tests.
//
// Exit codes: 0 success, 1 failed operation, 2 usage error.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, loadConfig } from "./config.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { RISK_ORDER } from "./lib/risk.mjs";
import { readStepResults } from "./lib/pr-body.mjs";
import {
  RunsError,
  indexRuns,
  latestPlan,
  localDate,
  now,
  parseArgs
} from "./runs.mjs";

export class RecapError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "RecapError";
    this.exitCode = exitCode;
  }
}

const BOM = String.fromCharCode(0xfeff);
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})-/;
const DEFAULT_LIMIT = 10;
const STOPWORDS = new Set(
  (
    "a an and are as at be but by did do does for from had has have how i if in is it its " +
    "of on or so that the their them then there they this to was we were what when where " +
    "which who why will with you your our not can could should would about into than"
  ).split(" ")
);

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function readText(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return text.startsWith(BOM) ? text.slice(1) : text;
}

function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** decisions.jsonl entries with their line number: [{ line, ...decision }]. */
export function readDecisions(dir) {
  const text = readText(join(dir, "decisions.jsonl"));
  if (text === null) return [];
  return text.split(/\r?\n/).flatMap((raw, index) => {
    if (raw.trim() === "") return [];
    try {
      return [{ line: index + 1, ...JSON.parse(raw) }];
    } catch {
      return [];
    }
  });
}

/**
 * summary.md split into frontmatter and `## ` sections. Returns null when the
 * run has no summary yet (still running, or owned by a caller).
 */
export function readSummary(dir) {
  const text = readText(join(dir, "summary.md"));
  if (text === null) return null;
  let frontmatter = null;
  try {
    frontmatter = parseFrontmatter(text);
  } catch {
    frontmatter = null;
  }
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const sections = {};
  let current = null;
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  for (const key of Object.keys(sections))
    sections[key] = sections[key].join("\n").trim();
  return { frontmatter, sections };
}

const isNone = (text) => !text || /^none\.?$/i.test(text.trim());

/** First paragraph of a section, or null. */
function firstParagraph(text) {
  if (isNone(text)) return null;
  return text
    .split(/\r?\n\s*\r?\n/)[0]
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

/** Critical findings from the review-<N>.json files of a run. */
export function readCriticalFindings(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  const files = readdirSync(dir)
    .map((name) => ({ name, m: /^review-(\d+)\.json$/.exec(name) }))
    .filter((f) => f.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  for (const { name, m } of files) {
    const review = readJson(join(dir, name));
    for (const f of review?.findings ?? []) {
      if (f.severity !== "critical") continue;
      found.push({
        round: Number(m[1]),
        id: f.id,
        dimension: f.dimension ?? null,
        class: f.class ?? null,
        location: f.location ?? null,
        title: f.title ?? null,
        source: join(dir, `review-${m[1]}.md`)
      });
    }
  }
  return found;
}

/** Commits of a run: milestone commits from state.json, then step record commits. */
function runCommits(dir, steps) {
  const commits = [];
  const add = (sha, from) => {
    if (sha && !commits.some((c) => c.sha === sha)) commits.push({ sha, from });
  };
  const state = readJson(join(dir, "state.json"));
  for (const id of state?.order ?? []) add(state.milestones?.[id]?.commit, id);
  for (const s of steps) add(s.result.commit, s.step);
  return commits;
}

function countByRisk(decisions) {
  const counts = Object.fromEntries(RISK_ORDER.map((r) => [r, 0]));
  for (const d of decisions) if (counts[d.risk] !== undefined) counts[d.risk]++;
  return counts;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function configFor(options) {
  return loadConfig({ projectDir: options["project-dir"] }).config;
}

function splitList(value) {
  return [value]
    .flat()
    .filter((v) => v !== undefined && v !== true)
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Roots to read: --root, else every recap.roots entry plus runs.root. */
export function resolveRoots(options, config) {
  let roots = splitList(options.root);
  if (roots.length === 0)
    roots = [...(config.recap?.roots ?? []), config.runs?.root].filter(Boolean);
  return [...new Set(roots.map((r) => resolve(expandHome(r))))];
}

function sinceFromLast(last, at) {
  const m = /^(\d+)([dwh])$/.exec(String(last));
  if (!m)
    throw new RecapError(`--last expects <N>d, <N>w or <N>h, got ${last}`, 2);
  const hours = { h: 1, d: 24, w: 24 * 7 }[m[2]] * Number(m[1]);
  return localDate(new Date(at.getTime() - hours * 3600 * 1000));
}

/**
 * Date range of a recap. --since/--until/--last win; --all reads every date;
 * otherwise the last recap.default_range_days days, today included.
 */
export function resolveRange(options, config, at) {
  const range = { since: options.since ?? null, until: options.until ?? null };
  if (options.last) range.since = sinceFromLast(options.last, at);
  if (!range.since && !range.until && !options.all) {
    const days = config.recap?.default_range_days ?? 7;
    range.since = localDate(
      new Date(at.getTime() - (days - 1) * 24 * 3600 * 1000)
    );
    range.default = true;
  }
  return range;
}

/** Runs in range, as runs.mjs index entries. */
export function selectRuns(options, env = process.env) {
  const config = configFor(options);
  const roots = resolveRoots(options, config);
  const range = resolveRange(options, config, now(env));
  let listed;
  try {
    listed = indexRuns(roots, {
      since: range.since ?? undefined,
      until: range.until ?? undefined,
      repo: options.repo,
      status: options.status,
      risk: options.risk
    });
  } catch (err) {
    if (err instanceof RunsError)
      throw new RecapError(err.message, err.exitCode);
    throw err;
  }
  let runs = listed.runs;
  if (options.limit) runs = limitTopLevel(runs, Number(options.limit));
  return { config, roots, range, runs, errors: listed.errors };
}

/**
 * Path of the listed run that holds this one on disk (`<parent>/units/<id>`
 * or `<parent>/tasks/<id>`), or null for a top-level run. `paths` is the set
 * of listed run paths: a child whose parent is filtered out stays top-level.
 */
function nestingPath(entry, paths) {
  if (!entry.parent) return null;
  const up = dirname(dirname(entry.path));
  return paths.has(up) ? up : null;
}

/** Path of the top-level run that holds this one (itself when top-level). */
function topLevelPath(entry, byPath) {
  const paths = new Set(byPath.keys());
  let current = entry;
  for (
    let up = nestingPath(current, paths);
    up;
    up = nestingPath(current, paths)
  )
    current = byPath.get(up);
  return current.path;
}

/** Keep the `limit` most recent top-level runs and every run nested in them. */
function limitTopLevel(runs, limit) {
  const byPath = new Map(runs.map((r) => [r.path, r]));
  const top = runs.filter((r) => topLevelPath(r, byPath) === r.path);
  const kept = new Set(top.slice(-limit).map((r) => r.path));
  return runs.filter((r) => kept.has(topLevelPath(r, byPath)));
}

/**
 * Children of a run from its run.json `children` (`{ id, path }`), with the
 * status and pull request read from each child run.json (null when missing).
 */
function readChildren(run) {
  const children = Array.isArray(run?.children) ? run.children : [];
  return children
    .filter((c) => c && typeof c.id === "string")
    .map((c) => {
      const child = c.path ? readJson(join(c.path, "run.json")) : null;
      return {
        id: c.id,
        path: c.path ?? null,
        status: child?.status ?? null,
        pr: child?.pr ?? null
      };
    });
}

/** Index entry for a run directory, like runs.mjs indexRuns builds it. */
function entryFor(dir, run, date, parentId) {
  return {
    id: run.id,
    path: dir,
    date,
    parent: run.parent ?? parentId,
    type: run.type,
    workflow: run.workflow ?? null,
    title: run.title ?? null,
    repo: run.repo ?? null,
    branch: run.branch ?? null,
    pr: run.pr ?? null,
    status: run.status,
    max_risk: run.max_risk ?? null,
    started_at: run.started_at ?? null,
    ended_at: run.ended_at ?? null
  };
}

/**
 * Index entries of the child runs of `dir`: the run.json `children` first,
 * then any other run directory under `units/` or `tasks/`.
 */
function childEntries(dir, run, date) {
  const dirs = [];
  const add = (path) => {
    if (path && !dirs.includes(resolve(path))) dirs.push(resolve(path));
  };
  for (const c of readChildren(run)) add(c.path);
  for (const nest of ["units", "tasks"]) {
    const base = join(dir, nest);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) add(join(base, name));
  }
  return dirs.flatMap((path) => {
    const child = readJson(join(path, "run.json"));
    return child ? [entryFor(path, child, date, run.id)] : [];
  });
}

// ---------------------------------------------------------------------------
// Run digests
// ---------------------------------------------------------------------------

/**
 * Track of an esp-ship run from its ship.json: the current track and the
 * tracks it started on (an inline run escalated to orchestrated reports
 * `{ current: "orchestrated", history: ["inline", "orchestrated"] }`). Null
 * for runs without ship.json (runs from before 0.8.0, other
 * runs), which keep their recorded workflow names.
 */
export function readTrack(dir) {
  const ship = readJson(join(dir, "ship.json"));
  if (!ship || typeof ship.track !== "string") return null;
  const history = [];
  for (const h of ship.track_history ?? []) {
    if (history.length === 0 && h.from) history.push(h.from);
    if (h.to) history.push(h.to);
  }
  if (history.length === 0) history.push(ship.track);
  return { current: ship.track, history };
}

/** Compact view of one run for recap mode: what happened and where to look. */
export function digestRun(entry) {
  const dir = entry.path;
  const summary = readSummary(dir);
  const decisions = readDecisions(dir);
  const steps = readStepResults(dir);
  const critical = readCriticalFindings(dir);
  const run = readJson(join(dir, "run.json"));
  const fm = summary?.frontmatter ?? {};
  return {
    id: entry.id,
    path: dir,
    date: entry.date,
    parent: entry.parent,
    title: fm.title ?? entry.title ?? entry.id,
    workflow: fm.workflow ?? entry.workflow,
    run_workflow: entry.workflow,
    track: readTrack(dir),
    repo: entry.repo,
    branch: entry.branch,
    pr: fm.pr ?? entry.pr,
    status: entry.status,
    summary_status: fm.status ?? null,
    max_risk: entry.max_risk,
    started_at: entry.started_at,
    ended_at: entry.ended_at,
    duration_minutes: fm.duration_minutes ?? null,
    outcome: firstParagraph(summary?.sections?.Outcome),
    decisions: { count: decisions.length, by_risk: countByRisk(decisions) },
    critical_findings: Math.max(
      Number(fm.critical_findings ?? 0) || 0,
      critical.length
    ),
    steps: steps.map((s) => ({ step: s.step, status: s.result.status })),
    commits: runCommits(dir, steps).length,
    children: readChildren(run),
    sources: {
      run: join(dir, "run.json"),
      summary: summary ? join(dir, "summary.md") : null,
      decisions: decisions.length > 0 ? join(dir, "decisions.jsonl") : null
    }
  };
}

/**
 * Everything about one run, for a detailed recap or a fan-out subagent. A
 * parent run also gets `units`: the digest of each of its child runs.
 */
export function showRun(dir) {
  const run = readJson(join(dir, "run.json"));
  if (!run)
    throw new RecapError(`Not a run directory (no readable run.json): ${dir}`);
  const summary = readSummary(dir);
  const steps = readStepResults(dir);
  let plan = null;
  try {
    const latest = latestPlan(dir);
    plan = latest.path ? { version: latest.version, path: latest.path } : null;
  } catch {
    plan = null;
  }
  return {
    path: dir,
    run,
    track: readTrack(dir),
    summary: summary
      ? {
          path: join(dir, "summary.md"),
          frontmatter: summary.frontmatter,
          sections: summary.sections
        }
      : null,
    plan,
    decisions: readDecisions(dir).map((d) => ({
      ...d,
      source: `${join(dir, "decisions.jsonl")}:${d.line}`
    })),
    steps: steps.map((s) => ({
      step: s.step,
      status: s.result.status,
      summary: s.result.summary ?? null,
      commit: s.result.commit ?? null,
      pr: s.result.pr ?? null,
      max_risk: s.result.max_risk ?? null,
      blockers: s.result.blockers ?? [],
      discovered_items: s.result.discovered_items ?? [],
      source: join(dir, s.step === "triage" ? "triage.json" : "ship.json")
    })),
    commits: runCommits(dir, steps),
    critical_findings: readCriticalFindings(dir),
    units: childEntries(
      dir,
      run,
      DATE_PREFIX.exec(basename(dir))?.[1] ?? null
    ).map(digestRun)
  };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Nest digests under their parent: each digest gets `units` (the digests of
 * its child runs in range), and only top-level digests are returned.
 */
function nestDigests(runs) {
  const paths = new Set(runs.map((r) => r.path));
  const digests = new Map(
    runs.map((r) => [r.path, { ...digestRun(r), units: [] }])
  );
  const top = [];
  for (const r of runs) {
    const up = nestingPath(r, paths);
    if (up) digests.get(up).units.push(digests.get(r.path));
    else top.push(digests.get(r.path));
  }
  return top;
}

/**
 * Recap mode: one digest per top-level run, child runs nested under their
 * parent (`units`), and fan-out batches of top-level runs above the threshold
 * (a fan-out subagent reads the units through `show` of the parent).
 */
export function cmdCollect(options, env = process.env) {
  const { config, roots, range, runs, errors } = selectRuns(options, env);
  const threshold = config.recap?.fan_out_threshold ?? 5;
  const top = nestDigests(runs);
  const fanOut = top.length > threshold;
  return {
    roots,
    range,
    count: top.length,
    unit_count: runs.length - top.length,
    fan_out: fanOut,
    fan_out_threshold: threshold,
    batches: fanOut
      ? chunk(
          top.map((r) => r.path),
          threshold
        )
      : [],
    runs: top,
    errors
  };
}

const runLabel = (r) => (r.parent ? `${r.parent}/${r.id}` : r.id);

/**
 * Resolve `show <run-id|parent-id/unit-id|path>` against the roots. A bare ID
 * that names several runs (units of different parents) fails with the
 * candidates, to be retried as `<parent-id>/<unit-id>`.
 */
export function findRun(target, options) {
  if (options["run-dir"]) target = options["run-dir"];
  if (!target || target === true)
    throw new RecapError(
      "Usage: show <run-id|parent-id/unit-id|path> (or --run-dir <path>)",
      2
    );
  target = String(target);
  const direct = resolve(expandHome(target));
  if (existsSync(join(direct, "run.json"))) return direct;
  const roots = resolveRoots(options, configFor(options));
  const { runs } = indexRuns(roots, {});
  const named = (r, id) => r.id === id || basename(r.path) === id;
  const pair = /^([^/\\]+)\/([^/\\]+)$/.exec(target);
  const hits = runs.filter((r) =>
    pair ? r.parent === pair[1] && named(r, pair[2]) : named(r, target)
  );
  const unique = [...new Map(hits.map((r) => [r.path, r])).values()];
  if (unique.length === 0)
    throw new RecapError(`No run named ${target} under ${roots.join(", ")}`);
  if (unique.length > 1)
    throw new RecapError(
      `${target} names ${unique.length} runs; pass one of:\n` +
        unique.map((r) => `  ${runLabel(r)}  (${r.path})`).join("\n")
    );
  return unique[0].path;
}

export function cmdShow(target, options) {
  return showRun(findRun(target, options));
}

/**
 * Risk report: decisions at or above --min-risk (default high), critical
 * review findings, and runs that halted or wait for a human. Every item
 * carries the path (and line) of its source artifact.
 */
export function cmdRisks(options, env = process.env) {
  const minRisk = options["min-risk"] ?? "high";
  const floor = RISK_ORDER.indexOf(minRisk);
  if (floor === -1)
    throw new RecapError(
      `--min-risk expects one of ${RISK_ORDER.join(", ")}`,
      2
    );
  const { roots, range, runs, errors } = selectRuns(options, env);
  const decisions = [];
  const findings = [];
  const stopped = [];
  for (const entry of runs) {
    const dir = entry.path;
    const summary = readSummary(dir);
    const critical = readCriticalFindings(dir);
    const title = summary?.frontmatter?.title ?? entry.title ?? entry.id;
    const ref = {
      run: entry.id,
      parent: entry.parent ?? null,
      title,
      repo: entry.repo,
      pr: entry.pr
    };
    for (const d of readDecisions(dir)) {
      if (RISK_ORDER.indexOf(d.risk) < floor) continue;
      decisions.push({
        ...ref,
        id: d.id,
        at: d.at,
        phase: d.phase,
        source_kind: d.source,
        risk: d.risk,
        class: d["x-esp-class"] ?? null,
        decision: d.decision,
        rationale: d.rationale,
        alternatives: d.alternatives ?? [],
        files: d.files ?? [],
        commit: d.commit ?? null,
        source: `${join(dir, "decisions.jsonl")}:${d.line}`
      });
    }
    for (const f of critical) findings.push({ ...ref, ...f });
    const section = summary?.sections?.["Critical Findings"];
    if (critical.length === 0 && !isNone(section)) {
      findings.push({
        ...ref,
        round: null,
        id: null,
        title: firstParagraph(section),
        source: join(dir, "summary.md")
      });
    }
    if (
      ["halted", "awaiting-human", "blocked", "failed"].includes(entry.status)
    ) {
      stopped.push({
        ...ref,
        status: entry.status,
        max_risk: entry.max_risk,
        source: join(dir, "run.json")
      });
    }
  }
  const rank = (d) => -RISK_ORDER.indexOf(d.risk);
  decisions.sort(
    (a, b) => rank(a) - rank(b) || String(a.at).localeCompare(String(b.at))
  );
  return {
    roots,
    range,
    min_risk: minRisk,
    runs: runs.length,
    decisions,
    critical_findings: findings,
    stopped_runs: stopped,
    errors
  };
}

/** Strip a common English suffix, so "rotated" and "tokens" match "rotate" and "token". */
function stem(word) {
  const m = /^(.{4,}?)(ing|ed|es|s)$/.exec(word);
  return m && !word.includes("/") ? m[1] : word;
}

/** Lowercase keyword stems of a question, without stopwords and short words. */
export function keywords(question) {
  return [
    ...new Set(
      String(question ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .map((w) => w.replace(/^[./-]+|[./-]+$/g, ""))
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
        .map(stem)
    )
  ];
}

function score(text, words) {
  const hay = String(text ?? "").toLowerCase();
  return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
}

/**
 * Q&A candidates in the plan's source order: decisions, summaries, then what
 * the skill needs for git log/blame (repo, branch, commits, files) and for the
 * pull request descriptions and comments (URLs).
 */
export function cmdSources(options, env = process.env) {
  const question = options.question ?? options.q;
  if (!question || question === true)
    throw new RecapError("sources requires --question <text>", 2);
  const words = keywords(question);
  if (words.length === 0)
    throw new RecapError("--question has no searchable keywords", 2);
  const limit = Number(options.limit ?? DEFAULT_LIMIT);
  const { roots, range, runs, errors } = selectRuns(
    { ...options, limit: undefined },
    env
  );
  const decisions = [];
  const summaries = [];
  const git = [];
  const prs = [];
  for (const entry of runs) {
    const dir = entry.path;
    const parent = entry.parent ?? null;
    let hits = 0;
    const files = new Set();
    for (const d of readDecisions(dir)) {
      const s = score(
        [
          d.decision,
          d.rationale,
          ...(d.alternatives ?? []),
          ...(d.files ?? []),
          ...(d.refs ?? [])
        ].join(" "),
        words
      );
      if (s === 0) continue;
      hits += s;
      for (const f of d.files ?? []) files.add(f);
      decisions.push({
        score: s,
        run: entry.id,
        parent,
        id: d.id,
        phase: d.phase,
        risk: d.risk,
        decision: d.decision,
        rationale: d.rationale,
        alternatives: d.alternatives ?? [],
        files: d.files ?? [],
        commit: d.commit ?? null,
        source: `${join(dir, "decisions.jsonl")}:${d.line}`
      });
    }
    const summary = readSummary(dir);
    for (const [heading, text] of Object.entries(summary?.sections ?? {})) {
      if (isNone(text)) continue;
      const s = score(text, words);
      if (s === 0) continue;
      hits += s;
      summaries.push({
        score: s,
        run: entry.id,
        parent,
        section: heading,
        text,
        source: `${join(dir, "summary.md")}#${heading}`
      });
    }
    const title = summary?.frontmatter?.title ?? entry.title ?? entry.id;
    hits += score(title, words);
    if (hits === 0) continue;
    const steps = readStepResults(dir);
    for (const s of steps)
      for (const f of s.result.files_changed ?? []) files.add(f);
    git.push({
      run: entry.id,
      parent,
      title,
      repo: entry.repo,
      branch: entry.branch,
      commits: runCommits(dir, steps),
      files: [...files].sort()
    });
    if (entry.pr) prs.push({ run: entry.id, parent, title, pr: entry.pr });
  }
  const byScore = (a, b) =>
    b.score - a.score || String(a.run).localeCompare(String(b.run));
  return {
    question,
    keywords: words,
    roots,
    range,
    runs: runs.length,
    order: ["decisions", "summaries", "git", "prs"],
    decisions: decisions.sort(byScore).slice(0, limit),
    summaries: summaries.sort(byScore).slice(0, limit),
    git,
    prs,
    errors
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node recap.mjs <command> [args] [options]

Commands:
  collect                Recap mode: one digest per top-level run in range, with its
                         child runs nested in units, and fan-out batches when the
                         top-level count is above recap.fan_out_threshold
  show <run>             One run in full: run.json, summary sections, decisions, steps,
                         commits, critical findings and child run digests (units),
                         each with its source path. <run> is a run ID, a path, or
                         <parent-id>/<unit-id> for a child run; an ambiguous ID fails
                         with the candidates
  risks                  Risk report: decisions at or above --min-risk (default high),
                         critical review findings, and halted or waiting runs
  sources                Q&A candidates for --question <text>, in source order:
                         decisions, summaries, git (repo, branch, commits, files), PRs

Filters (collect, risks, sources):
  --since <YYYY-MM-DD>   First day (directory date)
  --until <YYYY-MM-DD>   Last day
  --last <N>d|<N>w|<N>h  Shortcut for --since
  --all                  No date filter (default: the last recap.default_range_days days)
  --repo <name>          Repo, matched on the run.json repo suffix
  --status <s,...>       run.json status (repeatable or comma-separated)
  --risk <level>         Minimum run.json max_risk
  --limit <N>            Keep the N most recent top-level runs and their child runs
                         (sources: N results per source)

Options:
  --min-risk <level>        risks: lowest decision risk to report (default high)
  --question <text>         sources: the question to answer
  --root <dir>              A runs root to read (repeatable; default recap.roots plus runs.root)
  --project-dir <dir>       Project root for config resolution
  --help                    Show this help`;

export function run(argv, env = process.env) {
  const { command, args, options } = parseArgs(argv);
  if (options.help || !command)
    return { output: USAGE, exitCode: command ? 0 : 2 };
  if (options.all === true || options.all === "true") options.all = true;
  switch (command) {
    case "collect":
      return { output: cmdCollect(options, env) };
    case "show":
      return { output: cmdShow(args[0], options) };
    case "risks":
      return { output: cmdRisks(options, env) };
    case "sources":
      return { output: cmdSources(options, env) };
    default:
      throw new RecapError(`Unknown command: ${command}\n\n${USAGE}`, 2);
  }
}

function main() {
  try {
    const { output, exitCode = 0 } = run(process.argv.slice(2));
    const text =
      typeof output === "string" ? output : JSON.stringify(output, null, 2);
    (exitCode === 0 || typeof output !== "string"
      ? process.stdout
      : process.stderr
    ).write(`${text}\n`);
    process.exitCode = exitCode;
  } catch (err) {
    const known =
      err instanceof RecapError ||
      err instanceof RunsError ||
      err.name === "ConfigError";
    process.stderr.write(
      `recap error: ${known ? err.message : (err.stack ?? err)}\n`
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
