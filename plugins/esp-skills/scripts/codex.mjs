#!/usr/bin/env node
// esp-skills Codex runner: lets a Claude session, a subagent or a workflow
// agent delegate a declared task or a review to the Codex CLI and read the
// result back as JSON.
//
// Codex is a one-shot delegate: `codex exec` runs in a sandbox (read-only by
// default), is never steered mid-run, and its answer is read from the
// `--output-last-message` file (and parsed as JSON with --output-schema).
// Usage comes from the `turn.completed` events of the JSONL stream. On
// timeout the whole process tree is killed. The flags and events live in
// lib/codex.mjs.
//
// A run longer than one foreground Bash call starts with `run --detach`
// (prints { pid, out, status_path } at once) and is awaited with
// `wait --status-path <p> --max-minutes 9`, once per Bash call.
//
// ESP_CODEX_CMD (a JSON array) replaces the codex executable, for tests.
// Exit codes: 0 done (or still running for wait, ok for doctor), 1 failed,
// 2 usage error.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SANDBOX,
  DEFAULT_TIMEOUT_MINUTES,
  MIN_VERSION,
  SANDBOXES,
  classifyFailure,
  codexCommand,
  compareVersions,
  execArgs,
  isAlive,
  parseEvents,
  parseVersion,
  runProcess
} from "./lib/codex.mjs";
import { CLASSES, DIMENSIONS, SEVERITIES, resolveTarget } from "./review.mjs";
import { NOTES_MAX_LENGTH, appendDecision, appendNote } from "./runs.mjs";

export class CodexError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CodexError";
    this.exitCode = exitCode;
  }
}

const SCRIPT = fileURLToPath(import.meta.url);
const SUMMARY_MAX = 200;
export const DEFAULT_WAIT_MINUTES = 9;
export const DEFAULT_WAIT_INTERVAL_SECONDS = 5;
export const DOCTOR_TIMEOUT_MINUTES = 3;
export const DOCTOR_PROMPT = "Reply with the single word: ok";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function positiveNumber(value, flag, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (value === true || !Number.isFinite(n) || n <= 0)
    throw new CodexError(`${flag} expects a positive number`, 2);
  return n;
}

function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function firstLine(text) {
  const line =
    String(text ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  return line.length > SUMMARY_MAX
    ? `${line.slice(0, SUMMARY_MAX - 3)}...`
    : line;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isGitRepo(cwd) {
  const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  return res.status === 0;
}

function requireRunDir(value) {
  if (value === undefined) return null;
  const dir = resolve(String(value));
  if (value === true || !existsSync(join(dir, "run.json")))
    throw new CodexError(`Not a run directory (no run.json): ${dir}`, 2);
  return dir;
}

/**
 * The prompt text: inline, `@<file>` for a file's contents, or `-` for stdin
 * (a heredoc, which needs no temporary file and no path translation).
 */
export function readPrompt(value, readStdin = () => readFileSync(0, "utf8")) {
  if (value === undefined || value === true || String(value).trim() === "")
    throw new CodexError("--prompt <text|@file|-> is required", 2);
  const text = String(value);
  if (text === "-") {
    const input = readStdin();
    if (!input.trim())
      throw new CodexError("--prompt -: stdin holds no prompt", 2);
    return input;
  }
  if (!text.startsWith("@")) return text;
  const file = resolve(text.slice(1));
  if (!existsSync(file))
    throw new CodexError(`Prompt file not found: ${file}`, 2);
  return readFileSync(file, "utf8");
}

/**
 * Where the last message goes: --out, else `<run-dir>/codex/<kind>-<N>.md`,
 * else a new temporary directory.
 */
export function defaultOut(kind, runDir) {
  if (!runDir)
    return join(mkdtempSync(join(tmpdir(), "esp-codex-")), `${kind}.md`);
  const dir = join(runDir, "codex");
  mkdirSync(dir, { recursive: true });
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = new RegExp(`^${kind}-(\\d+)\\.md$`).exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return join(dir, `${kind}-${max + 1}.md`);
}

function logToRun(runDir, { decision, rationale, out, status, summary }, env) {
  if (!runDir) return null;
  try {
    const entry = appendDecision(
      runDir,
      {
        phase: "codex",
        source: "agent",
        risk: "low",
        decision,
        rationale,
        refs: [out]
      },
      env
    );
    const note = `Codex ${status}: ${summary}`;
    appendNote(
      runDir,
      null,
      note.length > NOTES_MAX_LENGTH
        ? `${note.slice(0, NOTES_MAX_LENGTH - 3)}...`
        : note
    );
    return { decision: entry.id };
  } catch (err) {
    return { log_error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Run one `codex exec` and read its result:
 * `{ status: done|failed, reason?, summary, out, usage, exit_code, ... }`.
 * With `schema`, the last message must be JSON and is returned as `result`.
 */
export async function runCodex(
  {
    prompt,
    cwd = process.cwd(),
    sandbox = DEFAULT_SANDBOX,
    model,
    schema,
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
    out,
    gitCheck,
    onSpawn
  },
  env = process.env
) {
  const cmd = codexCommand(env);
  mkdirSync(dirname(out), { recursive: true });
  const args = [
    ...cmd.slice(1),
    ...execArgs({
      out,
      sandbox,
      cwd,
      model,
      schema,
      gitCheck: gitCheck ?? isGitRepo(cwd)
    })
  ];
  const started = Date.now();
  const res = await runProcess(cmd[0], args, {
    cwd,
    env,
    input: prompt,
    timeoutMs: timeoutMinutes * 60_000,
    onSpawn
  });
  const events = parseEvents(res.stdout);
  let last = existsSync(out) ? readFileSync(out, "utf8") : null;
  if (last === null && events.lastMessage) {
    last = events.lastMessage;
    writeFileSync(out, last, "utf8");
  }
  const base = {
    out,
    usage: events.usage,
    exit_code: res.code,
    thread_id: events.threadId,
    duration_seconds: Math.round((Date.now() - started) / 1000)
  };
  const fail = (reason, error) => {
    const { kind, fix } = classifyFailure(error);
    return {
      status: "failed",
      reason,
      summary:
        reason === "timeout"
          ? `Codex timed out after ${timeoutMinutes} minutes`
          : `Codex failed: ${firstLine(error) || "no error message"}`,
      error: error ?? null,
      failure: kind,
      fix,
      ...base
    };
  };
  if (res.timedOut) return fail("timeout", "timeout");
  if (res.error) return fail("spawn", res.error.message);
  if (res.code !== 0 || events.error) {
    const stderrLine = res.stderr
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^\S+Z\s+(WARN|INFO|DEBUG)/.test(l))
      .pop();
    return fail("codex", events.error ?? stderrLine ?? `exit code ${res.code}`);
  }
  if (last === null || last.trim() === "")
    return fail("empty", "Codex returned no final message");
  const done = { status: "done", summary: firstLine(last), ...base };
  if (schema) {
    try {
      done.result = JSON.parse(last);
    } catch {
      return fail("invalid-output", "The final message is not valid JSON");
    }
  }
  return done;
}

function runOptions(options) {
  const sandbox = options.sandbox ?? DEFAULT_SANDBOX;
  if (!SANDBOXES.includes(sandbox))
    throw new CodexError(
      `--sandbox expects ${SANDBOXES.join(" or ")}, got ${sandbox === true ? "(missing)" : sandbox}`,
      2
    );
  const cwd = resolve(String(options.cwd ?? process.cwd()));
  if (!existsSync(cwd)) throw new CodexError(`--cwd not found: ${cwd}`, 2);
  const schema = options["output-schema"]
    ? resolve(String(options["output-schema"]))
    : undefined;
  if (schema && !existsSync(schema))
    throw new CodexError(`--output-schema not found: ${schema}`, 2);
  return {
    sandbox,
    cwd,
    schema,
    model: typeof options.model === "string" ? options.model : undefined,
    timeoutMinutes: positiveNumber(
      options["timeout-minutes"],
      "--timeout-minutes",
      DEFAULT_TIMEOUT_MINUTES
    )
  };
}

/** Write the running status, run, then write the final status. */
async function withStatus(statusPath, out, fn) {
  if (!statusPath) return fn(undefined);
  const startedAt = new Date().toISOString();
  writeJsonAtomic(statusPath, {
    status: "running",
    pid: process.pid,
    out,
    started_at: startedAt
  });
  let result;
  try {
    result = await fn((pid) =>
      writeJsonAtomic(statusPath, {
        status: "running",
        pid: process.pid,
        codex_pid: pid,
        out,
        started_at: startedAt
      })
    );
  } catch (err) {
    result = { status: "failed", reason: "error", summary: err.message, out };
  }
  writeJsonAtomic(statusPath, {
    ...result,
    started_at: startedAt,
    ended_at: new Date().toISOString()
  });
  return result;
}

export async function cmdRun(options, env = process.env) {
  const prompt = readPrompt(options.prompt);
  const opts = runOptions(options);
  const runDir = requireRunDir(options["run-dir"]);
  const out = options.out
    ? resolve(String(options.out))
    : defaultOut("run", runDir);
  if (options.detach) return detach("run", options, out, prompt);
  const statusPath = options["status-path"]
    ? resolve(String(options["status-path"]))
    : null;
  return withStatus(statusPath, out, async (onSpawn) => {
    const result = await runCodex({ prompt, out, onSpawn, ...opts }, env);
    const log = logToRun(
      runDir,
      {
        decision: `Delegated a task to Codex (${opts.sandbox})`,
        rationale: result.summary,
        out,
        status: result.status,
        summary: result.summary
      },
      env
    );
    return log ? { ...result, ...log } : result;
  });
}

// ---------------------------------------------------------------------------
// Detach and wait
// ---------------------------------------------------------------------------

const FORWARDED = [
  "cwd",
  "sandbox",
  "model",
  "output-schema",
  "timeout-minutes",
  "run-dir",
  "project-dir"
];

/**
 * Start the same command in a detached process and return at once with
 * `{ status: running, pid, out, status_path }`. The prompt is passed as a file.
 */
function detach(command, options, out, prompt, positional = []) {
  const statusPath = options["status-path"]
    ? resolve(String(options["status-path"]))
    : `${out}.status.json`;
  const args = [SCRIPT, command, ...positional, "--out", out];
  args.push("--status-path", statusPath);
  if (prompt !== undefined) {
    const promptFile = `${out}.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, prompt, "utf8");
    args.push("--prompt", `@${promptFile}`);
  }
  for (const key of FORWARDED) {
    if (typeof options[key] === "string") args.push(`--${key}`, options[key]);
  }
  writeJsonAtomic(statusPath, { status: "running", pid: null, out });
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env
  });
  child.unref();
  return { status: "running", pid: child.pid, out, status_path: statusPath };
}

/**
 * Block until a detached run ends or `--max-minutes` passes. A run still going
 * returns `{ status: running, ... }`; an ended one returns its result.
 */
export async function cmdWait(options) {
  if (!options["status-path"] || options["status-path"] === true)
    throw new CodexError("wait requires --status-path <file>", 2);
  const statusPath = resolve(String(options["status-path"]));
  const maxMs =
    positiveNumber(
      options["max-minutes"],
      "--max-minutes",
      DEFAULT_WAIT_MINUTES
    ) * 60_000;
  const intervalMs =
    positiveNumber(
      options["interval-seconds"],
      "--interval-seconds",
      DEFAULT_WAIT_INTERVAL_SECONDS
    ) * 1000;
  const started = Date.now();
  for (;;) {
    const state = readJson(statusPath);
    if (state === null && !existsSync(statusPath))
      throw new CodexError(`Status file not found: ${statusPath}`);
    if (state && state.status !== "running") return state;
    if (state?.pid && !isAlive(state.pid))
      return {
        ...state,
        status: "failed",
        reason: "exited",
        summary: "The Codex runner exited without writing a result"
      };
    const waited = Date.now() - started;
    if (waited >= maxMs)
      return {
        ...(state ?? {}),
        status: "running",
        status_path: statusPath,
        waited_seconds: Math.round(waited / 1000)
      };
    await sleep(Math.min(intervalMs, maxMs - waited));
  }
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/** The JSON Schema of a Codex review reply, in the esp-review finding format. */
export function reviewSchema() {
  const text = { type: "string" };
  const optionalText = { type: ["string", "null"] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "findings"],
    properties: {
      summary: text,
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "severity",
            "dimension",
            "class",
            "file",
            "line",
            "title",
            "evidence",
            "fix",
            "options",
            "recommended"
          ],
          properties: {
            severity: { type: "string", enum: SEVERITIES },
            dimension: { type: "string", enum: DIMENSIONS },
            class: { type: "string", enum: CLASSES },
            file: text,
            line: { type: ["integer", "null"] },
            title: text,
            evidence: text,
            fix: optionalText,
            options: optionalText,
            recommended: optionalText
          }
        }
      }
    }
  };
}

function describeTarget(t) {
  if (t.pr)
    return `pull request #${t.pr.number} (${t.pr.base} <- ${t.pr.head})`;
  if (t.kind === "local") return "the uncommitted changes";
  if (t.kind === "staged") return "the staged changes";
  if (t.kind === "unstaged") return "the unstaged changes";
  if (t.kind === "branch") return `the current branch against ${t.base_ref}`;
  return `${t.base}..${t.head}`;
}

/** The review prompt for a resolved target whose diff is in `diffPath`. */
export function reviewPrompt(target, diffPath) {
  const lines = [
    `Review ${describeTarget(target)} as a careful senior reviewer.`,
    "",
    `- Diff range: ${target.base ?? "?"}..${target.head ?? "?"}`,
    `- The full diff is in: ${diffPath}`
  ];
  if (target.untracked?.length)
    lines.push(
      `- New untracked files (read them in full): ${target.untracked.join(", ")}`
    );
  lines.push(
    "",
    "Read the diff, then the surrounding code in the repository as needed. This is a read-only review: do not modify any file.",
    "",
    `Report only real problems introduced or exposed by this change, each verified against the code: dimensions ${DIMENSIONS.join(", ")}.`,
    "For each finding give the severity, the dimension, the class (A: one clear fix; B-Decide: a choice between options, with options and recommended; B-Scope: out of scope for this change), the file and line, a one-line title, the evidence, and the fix (null only for B-Decide).",
    "Skip style nits a formatter fixes. An empty findings list is a valid answer.",
    "",
    "Reply with JSON matching the output schema: a one-line summary and the findings."
  );
  return `${lines.join("\n")}\n`;
}

/** Codex review findings in the esp-review shape, tagged `source: codex`. */
export function normalizeFindings(result) {
  const list = Array.isArray(result?.findings) ? result.findings : [];
  return list.map((f, i) => ({
    id: `C${i + 1}`,
    source: "codex",
    severity: f.severity,
    dimension: f.dimension,
    class: f.class,
    file: f.file,
    line: Number.isInteger(f.line) ? f.line : null,
    location: Number.isInteger(f.line) ? `${f.file}:${f.line}` : f.file,
    title: f.title,
    evidence: f.evidence ?? null,
    fix: f.fix ?? null,
    options: f.options ?? null,
    recommended: f.recommended ?? null
  }));
}

export async function cmdReview(target, options, env = process.env) {
  const opts = runOptions({ ...options, sandbox: "read-only" });
  if (options.sandbox && options.sandbox !== "read-only")
    throw new CodexError("review always runs read-only", 2);
  const runDir = requireRunDir(options["run-dir"]);
  const out = options.out
    ? resolve(String(options.out))
    : defaultOut("review", runDir);
  if (options.detach)
    return detach("review", options, out, undefined, target ? [target] : []);
  const statusPath = options["status-path"]
    ? resolve(String(options["status-path"]))
    : null;
  return withStatus(statusPath, out, async (onSpawn) => {
    let resolved;
    try {
      resolved = resolveTarget(target, { cwd: opts.cwd, env });
    } catch (err) {
      throw new CodexError(err.message, err.exitCode ?? 1);
    }
    const targetInfo = {
      kind: resolved.kind,
      target: resolved.target,
      base: resolved.base,
      head: resolved.head,
      pr: resolved.pr
    };
    if (!resolved.diff?.trim() && !resolved.untracked?.length)
      return {
        status: "done",
        summary: "Nothing to review: the diff is empty",
        out: null,
        target: targetInfo,
        findings: []
      };
    const stem = out.replace(/\.md$/, "");
    const diffPath = `${stem}.diff`;
    const schemaPath = `${stem}.schema.json`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(diffPath, resolved.diff ?? "", "utf8");
    writeJsonAtomic(schemaPath, reviewSchema());
    const result = await runCodex(
      {
        ...opts,
        prompt: reviewPrompt(resolved, diffPath),
        schema: schemaPath,
        out,
        onSpawn
      },
      env
    );
    const { result: reply, ...rest } = result;
    const review = { ...rest, target: targetInfo, diff: diffPath };
    if (result.status === "done") {
      review.findings = normalizeFindings(reply);
      review.summary = firstLine(reply?.summary) || result.summary;
    }
    const log = logToRun(
      runDir,
      {
        decision: `Ran a Codex review of ${describeTarget(resolved)}`,
        rationale:
          result.status === "done"
            ? `${review.findings.length} finding(s): ${review.summary}`
            : review.summary,
        out,
        status: review.status,
        summary: review.summary
      },
      env
    );
    return log ? { ...review, ...log } : review;
  });
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

function runSync(cmd, args, env) {
  const res = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 60_000
  });
  return res;
}

/**
 * Check that Codex is installed at MIN_VERSION or later, logged in, and able
 * to answer a minimal prompt. Stops at the first failed check.
 */
export async function cmdDoctor(options, env = process.env) {
  const cmd = codexCommand(env);
  const checks = [];
  const report = (status, summary, extra = {}) => ({
    status,
    summary,
    min_version: MIN_VERSION,
    checks,
    ...extra
  });
  const failed = (name, detail, fix) => {
    checks.push({ name, ok: false, detail, fix });
    const text = String(detail).replace(/[.\s]+$/, "");
    return report(
      "failed",
      `${name} failed: ${text}${fix ? `. Fix: ${fix}` : ""}`
    );
  };

  const ver = runSync(cmd, ["--version"], env);
  if (ver.error || ver.status !== 0) {
    const detail = ver.error?.message ?? (ver.stderr || ver.stdout).trim();
    return failed(
      "install",
      `codex could not run (${firstLine(detail)})`,
      `install the Codex CLI ${MIN_VERSION} or later: npm i -g @openai/codex`
    );
  }
  const version = parseVersion(ver.stdout);
  if (!version || compareVersions(version, MIN_VERSION) < 0)
    return failed(
      "version",
      `Codex ${version ?? "(unknown version)"} is older than ${MIN_VERSION}`,
      "upgrade: npm i -g @openai/codex@latest"
    );
  checks.push({ name: "version", ok: true, detail: version });

  const login = runSync(cmd, ["login", "status"], env);
  const loginText = firstLine(`${login.stdout ?? ""}\n${login.stderr ?? ""}`);
  if (login.error || login.status !== 0 || /not logged in/i.test(loginText))
    return failed("login", loginText || "not logged in", "run `codex login`");
  checks.push({ name: "login", ok: true, detail: loginText });

  if (!options["no-smoke"]) {
    const dir = mkdtempSync(join(tmpdir(), "esp-codex-doctor-"));
    const result = await runCodex(
      {
        prompt: DOCTOR_PROMPT,
        cwd: dir,
        sandbox: "read-only",
        model: typeof options.model === "string" ? options.model : undefined,
        timeoutMinutes: positiveNumber(
          options["timeout-minutes"],
          "--timeout-minutes",
          DOCTOR_TIMEOUT_MINUTES
        ),
        out: join(dir, "doctor.md"),
        gitCheck: false
      },
      env
    );
    if (result.status !== "done")
      return failed(
        "smoke",
        firstLine(result.error ?? result.summary),
        result.fix ?? "run `codex exec` by hand to see the full error"
      );
    checks.push({ name: "smoke", ok: true, detail: result.summary });
  }
  return report("ok", `Codex ${version} is ready`, { version });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: codex.mjs <command> [options]

Commands:
  run       Run a task on Codex and print its result
            --prompt <text|@file|-> [--cwd <dir>] [--sandbox read-only|workspace-write]
            [--model <m>] [--output-schema <file>] [--timeout-minutes <n>]
            [--out <file>] [--run-dir <dir>] [--detach] [--status-path <file>]
  wait      Wait for a detached run: --status-path <file> [--max-minutes <n>]
            [--interval-seconds <n>]
  review    Read-only Codex review of [target] (same targets as review.mjs:
            local changes, a ref, a range or a pull request)
            [--cwd <dir>] [--model <m>] [--timeout-minutes <n>] [--out <file>]
            [--run-dir <dir>] [--detach]
  doctor    Check install, version (>= ${MIN_VERSION}), login and a smoke prompt
            [--model <m>] [--no-smoke]

Output: JSON on stdout. run and review print
  { status: done|failed, reason?, summary, out, usage, exit_code, ... }
run --detach prints { status: running, pid, out, status_path }.

Options:
  --sandbox <mode>          read-only (default) or workspace-write
  --timeout-minutes <n>     Kill the Codex process tree after n minutes (default ${DEFAULT_TIMEOUT_MINUTES})
  --run-dir <dir>           Log one decision and a notes.md line to this run
  --help                    Show this help`;

const BOOLEAN_FLAGS = new Set(["help", "detach", "no-smoke"]);

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
          throw new CodexError(`--${key} requires a value`, 2);
      }
      options[key] = value;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], args: positional.slice(1), options };
}

const FAILED_EXIT = (out) => (out.status === "failed" ? 1 : 0);

export async function run(argv, env = process.env) {
  const { command, args, options } = parseArgs(argv);
  if (options.help || !command)
    return { output: USAGE, exitCode: command ? 0 : 2 };
  let output;
  switch (command) {
    case "run":
      output = await cmdRun(options, env);
      break;
    case "wait":
      output = await cmdWait(options);
      break;
    case "review":
      output = await cmdReview(args[0], options, env);
      break;
    case "doctor":
      output = await cmdDoctor(options, env);
      break;
    default:
      throw new CodexError(`Unknown command: ${command}\n\n${USAGE}`, 2);
  }
  return { output, exitCode: FAILED_EXIT(output) };
}

async function main() {
  try {
    const { output, exitCode = 0 } = await run(process.argv.slice(2));
    const text =
      typeof output === "string" ? output : JSON.stringify(output, null, 2);
    (exitCode === 0 || typeof output !== "string"
      ? process.stdout
      : process.stderr
    ).write(`${text}\n`);
    process.exitCode = exitCode;
  } catch (err) {
    const known = err instanceof CodexError || err.name === "ReviewError";
    process.stderr.write(
      `codex error: ${known ? err.message : (err.stack ?? err)}\n`
    );
    process.exitCode = known ? (err.exitCode ?? 1) : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  main();
}
