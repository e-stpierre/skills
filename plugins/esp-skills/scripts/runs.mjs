#!/usr/bin/env node
// esp-skills run directories (layout: references/run-directory.md).
//
// Creates and updates run directories so no skill writes the JSON layouts by
// hand. run.json and every decision are checked (lib/run-files.mjs) before
// they are written.
//
// Run location: --run-dir <path> when given (a parent skill owns the run),
// otherwise <runs.root>/<YYYY-MM-DD>-<slug> from the resolved config.
// Appends to *.jsonl files and run.json updates hold `<file>.lock`.
// ESP_RUNS_NOW (ISO date-time) fixes the clock, for tests.
//
// Exit codes: 0 success, 1 invalid file or failed operation, 2 usage error.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, loadConfig } from "./config.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { withLock } from "./lib/lock.mjs";
import { RISK_ORDER, maxRisk } from "./lib/risk.mjs";
import { CHECKS, TERMINAL_RUN_STATUSES } from "./lib/run-files.mjs";
import {
  ATTRIBUTION,
  BODY_SECTIONS,
  collectRunArtifacts,
  renderPrBody
} from "./lib/pr-body.mjs";

export class RunsError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "RunsError";
    this.exitCode = exitCode;
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATED_DIR = /^(\d{4}-\d{2}-\d{2})-/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current time, overridable with ESP_RUNS_NOW. */
export function now(env = process.env) {
  if (env.ESP_RUNS_NOW) {
    const fixed = new Date(env.ESP_RUNS_NOW);
    if (Number.isNaN(fixed.getTime()))
      throw new RunsError(`Invalid ESP_RUNS_NOW: ${env.ESP_RUNS_NOW}`, 2);
    return fixed;
  }
  return new Date();
}

/** Local calendar date (YYYY-MM-DD) of a Date. */
export function localDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Turn free text into a directory-safe slug. */
export function slugify(text) {
  const slug = String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (!slug)
    throw new RunsError(
      "A slug with at least one letter or digit is required",
      2
    );
  return slug;
}

function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new RunsError(
      `${path}: cannot read file (${err.code ?? err.message})`
    );
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new RunsError(`${path}: invalid JSON (${err.message})`);
  }
}

function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function assertValid(kind, value, source) {
  const errors = CHECKS[kind](value);
  if (errors.length > 0) {
    const lines = errors.map((e) => `  ${e.path}: ${e.message}`);
    throw new RunsError(`Invalid ${kind} (${source}):\n${lines.join("\n")}`);
  }
}

/** Number of lines up to the last non-blank one (trailing blank lines do not count). */
function jsonlEnd(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return end;
}

/** Physical line count of a jsonl file. */
function countLines(path) {
  if (!existsSync(path)) return 0;
  return jsonlEnd(readFileSync(path, "utf8").split("\n"));
}

/**
 * Append one entry to a jsonl file under its lock. `build(lineNumber)` returns
 * the entry; it receives the 1-based number the new line will have.
 */
function appendJsonl(path, kind, build) {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, () => {
    const entry = build(countLines(path) + 1);
    assertValid(kind, entry, path);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  });
}

function parseJsonInput(raw, what) {
  if (raw === undefined || raw === true) {
    throw new RunsError(`${what} requires --json <object> or JSON on stdin`, 2);
  }
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("expected a JSON object");
    return value;
  } catch (err) {
    throw new RunsError(`${what}: invalid JSON input (${err.message})`, 2);
  }
}

export function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return undefined;
  }
}

function requireRunDir(options) {
  if (!options["run-dir"])
    throw new RunsError("--run-dir <path> is required", 2);
  const dir = resolve(expandHome(options["run-dir"]));
  if (!existsSync(join(dir, "run.json")))
    throw new RunsError(`Not a run directory (no run.json): ${dir}`);
  return dir;
}

function runId(dir) {
  return readJsonFile(join(dir, "run.json")).id;
}

function configFor(options) {
  return loadConfig({ projectDir: options["project-dir"] }).config;
}

/** Runs root from --root, else runs.root in the config. */
export function runsRoot(options) {
  if (options.root)
    return resolve(expandHome(String([options.root].flat()[0])));
  return resolve(expandHome(configFor(options).runs.root));
}

function splitList(value) {
  return [value]
    .flat()
    .filter((v) => v !== undefined && v !== true)
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/** Raise run.json max_risk to `risk` when it is higher. */
export function raiseRunRisk(dir, risk, env) {
  if (!risk) return;
  const path = join(dir, "run.json");
  withLock(path, () => {
    const run = readJsonFile(path);
    const next = maxRisk(run.max_risk ?? null, risk);
    if (next === run.max_risk) return;
    run.max_risk = next;
    run.updated_at = now(env).toISOString();
    assertValid("run", run, path);
    writeJsonAtomic(path, run);
  });
}

const RUN_FIELDS = [
  "title",
  "workflow",
  "parent",
  "repo",
  "base",
  "branch",
  "worktree",
  "pr",
  "runtime"
];

export function cmdCreate(slugArg, options, env = process.env) {
  const at = now(env);
  let dir;
  if (options["run-dir"]) {
    dir = resolve(expandHome(options["run-dir"]));
  } else {
    const root = runsRoot(options);
    const base = `${options.date ?? localDate(at)}-${slugify(slugArg ?? options.title)}`;
    if (!DATED_DIR.test(base))
      throw new RunsError(`Invalid --date: ${options.date}`, 2);
    dir = join(root, base);
    for (let n = 2; existsSync(dir); n++) dir = join(root, `${base}-${n}`);
  }
  const runPath = join(dir, "run.json");
  if (existsSync(runPath)) {
    return { run_dir: dir, id: runId(dir), created: false };
  }
  const id = basename(dir);
  if (!ID_PATTERN.test(id))
    throw new RunsError(`Invalid run directory name: ${id}`, 2);
  const run = {
    id,
    type: options.type ?? "skill"
  };
  for (const field of RUN_FIELDS) run[field] = options[field] ?? null;
  Object.assign(run, {
    status: "running",
    max_risk: null,
    started_at: at.toISOString(),
    updated_at: at.toISOString(),
    ended_at: null,
    models: {},
    budgets_used: {}
  });
  assertValid("run", run, runPath);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(runPath, run);
  return { run_dir: dir, id, created: true };
}

export function cmdGet(options) {
  return readJsonFile(join(requireRunDir(options), "run.json"));
}

function parsePairs(values, what) {
  const out = {};
  for (const pair of splitList(values)) {
    const eq = pair.indexOf("=");
    if (eq <= 0)
      throw new RunsError(`${what} expects key=value, got ${pair}`, 2);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function cmdUpdate(options, env = process.env) {
  const dir = requireRunDir(options);
  const path = join(dir, "run.json");
  return withLock(path, () => {
    const current = readJsonFile(path);
    const next = structuredClone(current);
    for (const field of RUN_FIELDS) {
      if (options[field] !== undefined)
        next[field] = options[field] === "null" ? null : options[field];
    }
    if (options.type !== undefined) next.type = options.type;
    if (options["max-risk"] !== undefined)
      next.max_risk = maxRisk(next.max_risk ?? null, options["max-risk"]);
    for (const [role, spec] of Object.entries(
      parsePairs(options.model, "--model")
    )) {
      const [model, effort] = spec.split(":");
      next.models = {
        ...next.models,
        [role]: effort ? { model, effort } : { model }
      };
    }
    for (const [name, value] of Object.entries(
      parsePairs(options.budget, "--budget")
    )) {
      const number = Number(value);
      if (!Number.isFinite(number))
        throw new RunsError(`--budget ${name} must be a number`, 2);
      next.budgets_used = { ...next.budgets_used, [name]: number };
    }
    const at = now(env).toISOString();
    if (options.status !== undefined) {
      next.status = options.status;
      next.ended_at = TERMINAL_RUN_STATUSES.includes(options.status)
        ? at
        : null;
    }
    next.updated_at = at;
    assertValid("run", next, path);
    writeJsonAtomic(path, next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Append a decision; fills `id` (D001, D002, ...) and `at` when missing. */
export function appendDecision(dir, input, env = process.env) {
  const entry = appendJsonl(join(dir, "decisions.jsonl"), "decision", (n) => ({
    id: input.id ?? `D${String(n).padStart(3, "0")}`,
    at: input.at ?? now(env).toISOString(),
    ...input
  }));
  raiseRunRisk(dir, entry.risk, env);
  return entry;
}

export function cmdDecision(options, env = process.env) {
  const dir = requireRunDir(options);
  const input = parseJsonInput(options.json ?? readStdin(), "decision");
  return appendDecision(dir, input, env);
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** Latest plan version: plan.md is version 1, plan.v<N>.md is version N. */
export function latestPlan(dir) {
  const versions = [];
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (file === "plan.md")
      versions.push({ version: 1, path: join(dir, file) });
    const m = /^plan\.v(\d+)\.md$/.exec(file);
    if (m) versions.push({ version: Number(m[1]), path: join(dir, file) });
  }
  versions.sort((a, b) => a.version - b.version);
  const latest = versions.at(-1);
  return {
    path: latest?.path ?? null,
    version: latest?.version ?? 0,
    versions
  };
}

export function cmdPlan(options) {
  return latestPlan(requireRunDir(options));
}

// ---------------------------------------------------------------------------
// Run notes
// ---------------------------------------------------------------------------

// notes.md holds short facts for later workers: a pattern, a gotcha or a
// command that works, left by a builder or an iteration, and corrections the
// user sent during the run. Each line is `- **<scope>**: <text>`, where the
// scope is a milestone ID or `run` for a line that applies to the whole run,
// and an operator line adds ` (operator)` after the scope. Never committed.
// Verifiers do not read it.
export const NOTES_FILE = "notes.md";
export const NOTES_MAX_LENGTH = 500;
export const NOTES_RUN_SCOPE = "run";
export const NOTE_SOURCES = ["agent", "operator"];
const NOTES_HEADER = "# Run Notes\n\n";
const NOTE_LINE = /^- \*\*([^*]+)\*\*( \(operator\))?: (.*)$/;

/**
 * Parse notes.md into `{ milestone, from, text }` entries, in file order.
 * `milestone` is null on a run-wide line.
 */
export function readNotes(dir) {
  const path = join(dir, NOTES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => NOTE_LINE.exec(line))
    .filter(Boolean)
    .map((m) => ({
      milestone: m[1] === NOTES_RUN_SCOPE ? null : m[1],
      from: m[2] ? "operator" : "agent",
      text: m[3]
    }));
}

/**
 * Append one note under the notes.md lock; the text becomes one line. With no
 * milestone, the line applies to the whole run.
 */
export function appendNote(dir, milestone, text, from = "agent") {
  const scoped = milestone !== undefined && milestone !== null;
  if (
    scoped &&
    (milestone === true ||
      !ID_PATTERN.test(String(milestone)) ||
      String(milestone) === NOTES_RUN_SCOPE)
  )
    throw new RunsError(
      `notes --append expects --milestone <id>, got ${milestone === true ? "(missing)" : milestone}`,
      2
    );
  if (!NOTE_SOURCES.includes(from))
    throw new RunsError(
      `notes --from expects ${NOTE_SOURCES.join(" or ")}, got ${from === true ? "(missing)" : from}`,
      2
    );
  const line = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line || text === true)
    throw new RunsError("notes --append requires a non-empty text", 2);
  if (line.length > NOTES_MAX_LENGTH)
    throw new RunsError(
      `A note holds at most ${NOTES_MAX_LENGTH} characters (got ${line.length}): split it or keep only the fact`,
      2
    );
  const scope = scoped ? String(milestone) : NOTES_RUN_SCOPE;
  const marker = from === "operator" ? " (operator)" : "";
  const path = join(dir, NOTES_FILE);
  return withLock(path, () => {
    const prefix = existsSync(path) ? "" : NOTES_HEADER;
    appendFileSync(path, `${prefix}- **${scope}**${marker}: ${line}\n`, "utf8");
    return {
      path,
      entry: { milestone: scoped ? scope : null, from, text: line },
      count: readNotes(dir).length
    };
  });
}

export function cmdNotes(options) {
  const dir = requireRunDir(options);
  const append = options.append !== undefined;
  if (append === Boolean(options.show))
    throw new RunsError(
      "Usage: notes --append <text> [--milestone <id>] [--from operator|agent] | notes --show [--milestone <id>] --run-dir <path>",
      2
    );
  if (append)
    return appendNote(
      dir,
      options.milestone,
      options.append,
      options.from ?? "agent"
    );
  const all = readNotes(dir);
  const entries =
    options.milestone && options.milestone !== true
      ? all.filter(
          (e) =>
            e.milestone === null || e.milestone === String(options.milestone)
        )
      : all;
  return { path: join(dir, NOTES_FILE), count: entries.length, entries };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const DEFAULT_FS = { existsSync, readdirSync, readFileSync, statSync };

function sinceFromLast(last, at) {
  const m = /^(\d+)([dwh])$/.exec(String(last));
  if (!m)
    throw new RunsError(`--last expects <N>d, <N>w or <N>h, got ${last}`, 2);
  const hours = { h: 1, d: 24, w: 24 * 7 }[m[2]] * Number(m[1]);
  return localDate(new Date(at.getTime() - hours * 3600 * 1000));
}

function matchesRepo(repo, wanted) {
  if (!repo) return false;
  const a = repo.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  const b = wanted.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  return a === b || a.endsWith(`/${b}`);
}

/**
 * List runs under `roots`. Date filters use directory names only; every other
 * filter reads run.json and nothing else. Child runs under `tasks/` inherit
 * the date of their parent directory.
 */
export function indexRuns(roots, filters = {}, fs = DEFAULT_FS) {
  const statuses = splitList(filters.status);
  const minRisk = filters.risk ? RISK_ORDER.indexOf(filters.risk) : -1;
  if (filters.risk && minRisk === -1)
    throw new RunsError(`--risk expects one of ${RISK_ORDER.join(", ")}`, 2);
  for (const key of ["since", "until"]) {
    if (filters[key] && !/^\d{4}-\d{2}-\d{2}$/.test(filters[key]))
      throw new RunsError(
        `--${key} expects YYYY-MM-DD, got ${filters[key]}`,
        2
      );
  }
  const runs = [];
  const errors = [];

  const visit = (dir, date, parentId) => {
    const runPath = join(dir, "run.json");
    if (!fs.existsSync(runPath)) return;
    let run;
    try {
      run = JSON.parse(fs.readFileSync(runPath, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      errors.push({ path: runPath, message: err.message });
      return;
    }
    const keep =
      (statuses.length === 0 || statuses.includes(run.status)) &&
      (!filters.repo || matchesRepo(run.repo, filters.repo)) &&
      (minRisk === -1 || RISK_ORDER.indexOf(run.max_risk) >= minRisk);
    if (keep) {
      runs.push({
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
      });
    }
    const tasks = join(dir, "tasks");
    if (fs.existsSync(tasks)) {
      for (const child of fs.readdirSync(tasks).sort()) {
        visit(join(tasks, child), date, run.id);
      }
    }
  };

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort()) {
      const m = DATED_DIR.exec(name);
      if (!m) continue;
      const date = m[1];
      if (filters.since && date < filters.since) continue;
      if (filters.until && date > filters.until) continue;
      visit(join(root, name), date, null);
    }
  }
  runs.sort((a, b) =>
    a.date === b.date
      ? String(a.started_at ?? "").localeCompare(String(b.started_at ?? ""))
      : a.date.localeCompare(b.date)
  );
  const limited = filters.limit ? runs.slice(-Number(filters.limit)) : runs;
  return { runs: limited, errors };
}

export function cmdIndex(options, env = process.env) {
  let roots = splitList(options.root);
  if (roots.length === 0) {
    const config = configFor(options);
    roots = [...(config.recap?.roots ?? []), config.runs.root];
  }
  const resolved = [...new Set(roots.map((r) => resolve(expandHome(r))))];
  const filters = {
    since: options.since,
    until: options.until,
    repo: options.repo,
    status: options.status,
    risk: options.risk,
    limit: options.limit
  };
  if (options.last) filters.since = sinceFromLast(options.last, now(env));
  return { roots: resolved, ...indexRuns(resolved, filters) };
}

// ---------------------------------------------------------------------------
// File checks
// ---------------------------------------------------------------------------

/** The kind of a run file from its name: run.json, decisions.jsonl or summary.md. */
export function kindFor(file) {
  const name = basename(file);
  if (name === "run.json") return "run";
  if (name === "decisions.jsonl") return "decision";
  if (name === "summary.md") return "summary";
  return null;
}

/** Run the writers' field checks on a run.json, decisions.jsonl or summary.md. */
export function checkFile(file, kindName) {
  const path = resolve(file);
  if (!existsSync(path)) throw new RunsError(`File not found: ${path}`);
  const kind = kindName ?? kindFor(path);
  if (!Object.hasOwn(CHECKS, kind ?? ""))
    throw new RunsError(
      kindName
        ? `Unknown --kind ${kindName}; expected run, decision or summary`
        : `Cannot infer the kind of ${path}; pass --kind run|decision|summary`,
      2
    );
  const errors = [];
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const check = (value, line) => {
    for (const e of CHECKS[kind](value)) {
      errors.push(line ? { line, ...e } : e);
    }
  };
  if (path.endsWith(".jsonl")) {
    // Trailing empty lines come from the final newline; any other blank line
    // is an error.
    const lines = text.split("\n");
    const end = jsonlEnd(lines);
    for (let i = 0; i < end; i++) {
      const line = i + 1;
      if (lines[i].trim() === "") {
        errors.push({
          line,
          path: "(root)",
          message: "blank line inside a jsonl file"
        });
        continue;
      }
      let value;
      try {
        value = JSON.parse(lines[i]);
      } catch (err) {
        errors.push({
          line,
          path: "(root)",
          message: `invalid JSON (${err.message})`
        });
        continue;
      }
      check(value, line);
    }
  } else if (kind === "summary" && path.endsWith(".md")) {
    let data;
    try {
      data = parseFrontmatter(text);
    } catch (err) {
      errors.push({ path: "(frontmatter)", message: err.message });
    }
    if (data === null)
      errors.push({ path: "(frontmatter)", message: "is missing" });
    else if (data) check(data);
  } else {
    try {
      check(JSON.parse(text));
    } catch (err) {
      errors.push({ path: "(root)", message: `invalid JSON (${err.message})` });
    }
  }
  return { file: path, kind, valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Pull request body
// ---------------------------------------------------------------------------

/**
 * Pull request body built from the run artifacts (decisions.jsonl, the build
 * state.json and the esp-ship step records in ship.json), per pr.body_sections. Used by esp-pr with
 * a run directory when pr.body_from_run is on. --summary is the one free text.
 */
export function cmdPrBody(options) {
  const dir = requireRunDir(options);
  const config = configFor(options);
  const sections = config.pr?.body_sections ?? BODY_SECTIONS;
  const attribution = config.pr?.attribution === false ? null : ATTRIBUTION;
  const summary =
    options.summary && options.summary !== true
      ? String(options.summary)
      : null;
  const body = renderPrBody(collectRunArtifacts(dir), {
    summary,
    sections,
    attribution
  });
  if (options.out) {
    const out = resolve(expandHome(String(options.out)));
    writeFileSync(out, body, "utf8");
    return {
      path: out,
      bytes: Buffer.byteLength(body),
      body_from_run: config.pr?.body_from_run !== false
    };
  }
  return body;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node runs.mjs <command> [args] [options]

Commands:
  create [slug]          Create a run dir (<runs.root>/<YYYY-MM-DD>-<slug>, or --run-dir) and run.json
  get                    Print run.json
  update                 Update run.json fields (--status, --pr, --branch, --max-risk, --model, --budget, ...)
  decision               Append to decisions.jsonl (--json <object> or stdin); fills id and at
  plan                   Print the latest plan version (plan.md = 1, plan.v<N>.md = N)
  notes                  Run notes in notes.md: --append <text> [--milestone <id>] [--from operator|agent]
                         (one line, under the lock), or --show [--milestone <id>] (includes run-wide lines)
  index                  List runs (--root, --since, --until, --last 7d, --repo, --status, --risk, --limit)
  pr-body                Pull request body from the run artifacts (--summary <text>, --out <file>)
  check <file>           Check a run.json, decisions.jsonl or summary.md with the writers' field
                         checks (--kind run|decision|summary when the file name does not tell)

Options:
  --run-dir <path>          Run directory (required by every command except create, index, check)
  --root <dir>              Runs root for create, or a root to index (repeatable)
  --project-dir <dir>       Project root for config resolution
  --help                    Show this help`;

// `all` is a flag of recap.mjs, which reuses this parser.
const BOOLEAN_FLAGS = new Set(["all", "help", "show"]);
const REPEATABLE = new Set(["root", "model", "budget", "status"]);

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let value;
      if (BOOLEAN_FLAGS.has(key)) value = true;
      else if (eq !== -1) value = arg.slice(eq + 1);
      else {
        value = argv[++i];
        if (value === undefined)
          throw new RunsError(`--${key} requires a value`, 2);
      }
      if (REPEATABLE.has(key) && options[key] !== undefined)
        options[key] = [options[key]].flat().concat(value);
      else options[key] = value;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], args: positional.slice(1), options };
}

export function run(argv, env = process.env) {
  const { command, args, options } = parseArgs(argv);
  if (options.help || !command)
    return { output: USAGE, exitCode: command ? 0 : 2 };
  switch (command) {
    case "create":
      return { output: cmdCreate(args[0], options, env) };
    case "get":
      return { output: cmdGet(options) };
    case "update":
      return { output: cmdUpdate(options, env) };
    case "decision":
      return { output: cmdDecision(options, env) };
    case "plan":
      return { output: cmdPlan(options) };
    case "notes":
      return { output: cmdNotes(options) };
    case "index":
      return { output: cmdIndex(options, env) };
    case "pr-body":
      return { output: cmdPrBody(options) };
    case "check": {
      if (!args[0])
        throw new RunsError(
          "Usage: check <file> [--kind run|decision|summary]",
          2
        );
      const out = checkFile(args[0], options.kind);
      return { output: out, exitCode: out.valid ? 0 : 1 };
    }
    default:
      throw new RunsError(`Unknown command: ${command}\n\n${USAGE}`, 2);
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
    const known = err instanceof RunsError || err.name === "ConfigError";
    process.stderr.write(
      `runs error: ${known ? err.message : (err.stack ?? err)}\n`
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
