#!/usr/bin/env node
// esp-skills generic waits for esp-orchestrate.
//
// Polls until a condition is met or a deadline passes, so the orchestrator can
// wait on the steps between pull requests (a release workflow, a published
// package, a bot pull request) in a background script that costs no tokens.
//
// Commands:
//   command --run <cmd> [--cwd <dir>]
//       Run the shell command until it exits 0
//   pr --repo <owner/name> (--head <branch> | --author <login>)
//      [--base <branch>] [--title <regex>]
//       List the pull requests of the repository until one matches
//
// With --state <file>, the deadline is persisted: a rerun with the same kind
// and target after an interrupted wait keeps the first deadline, so a wait cut
// into slices still ends when the first call said it would. A rerun after a
// wait that ended starts a new deadline.
//
// The last stdout line is the outcome as JSON ({ status, summary, outputs }).
// Exit codes: 0 done, awaiting-human (deadline reached) or waiting (--once),
// 1 failed, 2 usage error.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, expandHome, loadConfig } from "./config.mjs";
import { now as runsNow } from "./runs.mjs";

export class WaitForError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "WaitForError";
    this.exitCode = exitCode;
  }
}

export const WAIT_FORMAT = 1;
export const KINDS = ["command", "pr"];
export const DEFAULT_TIMEOUT_MINUTES = 60;
export const DEFAULT_INTERVAL_SECONDS = 30;
/** Consecutive `gh` errors tolerated; the next one ends the wait as failed. */
export const MAX_GH_ERRORS = 3;
export const TAIL_CHARS = 2000;

const PR_FIELDS = "number,url,headRefName,author,title,baseRefName,state";

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Run a shell command once. */
export function execCommand(cmd, { cwd } = {}) {
  const res = spawnSync(cmd, {
    shell: true,
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ? res.error.message : null
  };
}

/** The last `TAIL_CHARS` characters of the command output. */
export function outputTail(stdout = "", stderr = "") {
  const text = [stdout, stderr].filter((part) => part).join("\n");
  return text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
}

/**
 * A `gh pr list` client. `ESP_GH_CMD` (a JSON array) replaces `gh`, for tests.
 * `list(repo)` returns the pull requests, or throws a `WaitForError`.
 */
export function ghClient(env = process.env) {
  let prefix;
  try {
    prefix = env.ESP_GH_CMD ? JSON.parse(env.ESP_GH_CMD) : ["gh"];
  } catch {
    throw new WaitForError("ESP_GH_CMD must be a JSON array", 2);
  }
  if (!Array.isArray(prefix) || prefix.length === 0)
    throw new WaitForError("ESP_GH_CMD must be a JSON array", 2);
  return {
    list(repo) {
      const args = [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--limit",
        "50",
        "--json",
        PR_FIELDS
      ];
      const res = spawnSync(prefix[0], [...prefix.slice(1), ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
      });
      if (res.error)
        throw new WaitForError(`gh could not run: ${res.error.message}`);
      if (res.status !== 0)
        throw new WaitForError(
          `gh pr list failed: ${(res.stderr || res.stdout || "").trim()}`
        );
      let list;
      try {
        list = JSON.parse(res.stdout);
      } catch {
        throw new WaitForError("gh pr list printed invalid JSON");
      }
      if (!Array.isArray(list))
        throw new WaitForError("gh pr list did not print an array");
      return list;
    }
  };
}

function authorLogin(pr) {
  const author = pr.author;
  if (author && typeof author === "object") return author.login ?? "";
  return typeof author === "string" ? author : "";
}

/**
 * The pull request of `list` matching every given field of `match` (`head`,
 * `author`, `base` exactly, `title` as a regular expression), open ones
 * first, then the newest. `null` when none matches.
 */
export function findPr(list, match) {
  const title = match.title ? new RegExp(match.title) : null;
  const found = list.filter(
    (pr) =>
      (!match.head || pr.headRefName === match.head) &&
      (!match.author ||
        authorLogin(pr).toLowerCase() === match.author.toLowerCase()) &&
      (!match.base || pr.baseRefName === match.base) &&
      (!title || title.test(pr.title ?? ""))
  );
  if (found.length === 0) return null;
  found.sort((a, b) => {
    const openA = a.state === "OPEN" ? 0 : 1;
    const openB = b.state === "OPEN" ? 0 : 1;
    return openA - openB || (b.number ?? 0) - (a.number ?? 0);
  });
  return found[0];
}

/** A one-line description of what a wait polls for. */
export function waitTarget(kind, spec) {
  if (kind === "command")
    return spec.cwd ? `${spec.run} (in ${spec.cwd})` : spec.run;
  const parts = [spec.repo];
  for (const key of ["head", "author", "base", "title"])
    if (spec[key]) parts.push(`${key}=${spec[key]}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * The wait clock: the previous state when it is the same wait (same kind and
 * target, not ended, a valid deadline), else a new one.
 */
export function openState(previous, { kind, target, timeoutMinutes, at }) {
  const resumable =
    previous &&
    previous.wait_format === WAIT_FORMAT &&
    previous.kind === kind &&
    previous.target === target &&
    !previous.ended_at &&
    Number.isFinite(Date.parse(previous.deadline ?? ""));
  if (resumable)
    return {
      ...previous,
      polls: previous.polls ?? 0,
      errors: previous.errors ?? 0,
      resumed_at: at.toISOString()
    };
  return {
    wait_format: WAIT_FORMAT,
    kind,
    target,
    started_at: at.toISOString(),
    deadline: new Date(at.getTime() + timeoutMinutes * 60_000).toISOString(),
    ended_at: null,
    polls: 0,
    errors: 0,
    status: "waiting",
    last_exit: null,
    resumed_at: null
  };
}

// ---------------------------------------------------------------------------
// The wait loop
// ---------------------------------------------------------------------------

/**
 * One check. Returns `{ met, fatal?, detail, extra }`: `met` ends the wait as
 * done, `fatal` as failed; otherwise the loop polls again.
 */
function checkOnce(ctx, kind, spec, state) {
  if (kind === "command") {
    const res = ctx.exec(spec.run, { cwd: spec.cwd });
    if (res.error) {
      state.last_exit = null;
      return {
        fatal: true,
        detail: `the command could not start: ${res.error}`,
        extra: { exit_code: null }
      };
    }
    state.last_exit = res.status;
    const extra = {
      exit_code: res.status,
      output_tail: outputTail(res.stdout, res.stderr)
    };
    return res.status === 0
      ? { met: true, detail: "the command exited 0", extra }
      : { met: false, detail: `the command exited ${res.status}`, extra };
  }
  let list;
  try {
    list = ctx.client.list(spec.repo);
    state.errors = 0;
  } catch (err) {
    if (!(err instanceof WaitForError)) throw err;
    state.errors = (state.errors ?? 0) + 1;
    state.last_exit = null;
    if (state.errors > MAX_GH_ERRORS)
      return {
        fatal: true,
        detail: `${err.message} (${state.errors} errors in a row)`,
        extra: {}
      };
    return { met: false, detail: `${err.message} (retrying)`, extra: {} };
  }
  state.last_exit = 0;
  const pr = findPr(list, spec);
  if (!pr) return { met: false, detail: "no matching pull request", extra: {} };
  return {
    met: true,
    detail: `#${pr.number} matches`,
    extra: {
      pr: {
        number: pr.number,
        url: pr.url,
        head: pr.headRefName,
        base: pr.baseRefName ?? null,
        title: pr.title ?? null,
        state: pr.state ?? null
      }
    }
  };
}

/**
 * Poll until the condition is met (`done`), cannot be met (`failed`), or the
 * deadline passes (`awaiting-human`). With `once`, a single check that is not
 * met returns `waiting`. `ctx` carries `exec`, `client`, `now`, `sleep`, `log`
 * and the optional `statePath`.
 */
export async function waitFor(
  ctx,
  kind,
  spec,
  { timeoutMinutes, intervalSeconds, once = false }
) {
  const { now, sleep, log = () => {}, statePath = null } = ctx;
  const target = waitTarget(kind, spec);
  const state = openState(readJson(statePath), {
    kind,
    target,
    timeoutMinutes,
    at: now()
  });
  state.status = "waiting";
  writeJson(statePath, state);
  const deadline = Date.parse(state.deadline);
  const subject =
    kind === "command" ? "the command" : "a matching pull request";

  const outcome = (status, summary, extra = {}) => {
    state.status = status;
    if (status !== "waiting") state.ended_at = now().toISOString();
    writeJson(statePath, state);
    const block = {
      status,
      summary,
      outputs: {
        kind,
        target,
        deadline: state.deadline,
        polls: state.polls,
        ...extra
      }
    };
    if (status === "failed" || status === "awaiting-human")
      block.blockers = [summary];
    return block;
  };

  for (;;) {
    state.polls += 1;
    const check = checkOnce(ctx, kind, spec, state);
    if (check.met)
      return outcome(
        "done",
        kind === "command"
          ? `The command succeeded after ${state.polls} poll(s).`
          : `Pull request ${check.extra.pr.url} matches ${target}.`,
        check.extra
      );
    if (check.fatal)
      return outcome(
        "failed",
        `Waiting for ${subject} failed: ${check.detail}.`,
        check.extra
      );
    const remaining = deadline - now().getTime();
    if (remaining <= 0)
      return outcome(
        "awaiting-human",
        `No success for ${subject} at the deadline (${state.deadline}), last: ${check.detail}. Check it, then wait again: a rerun starts a new deadline.`,
        { timed_out: true, ...check.extra }
      );
    if (once)
      return outcome(
        "waiting",
        `Not yet: ${check.detail}. The deadline is ${state.deadline}.`,
        check.extra
      );
    writeJson(statePath, state);
    log(
      `poll ${state.polls}: ${check.detail}, waiting until ${state.deadline}`
    );
    await sleep(Math.min(intervalSeconds * 1000, remaining));
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: wait-for.mjs <command> [options]

Commands:
  command --run <cmd> [--cwd <dir>]
                          Run the shell command until it exits 0
  pr --repo <owner/name> (--head <branch> | --author <login>) [--base <branch>]
     [--title <regex>]    Wait until a pull request of the repository matches
                          (head, author and base exactly, title as a regex)

Options:
  --state <file>          Persisted clock: a rerun of the same wait keeps the
                          deadline until the wait ends
  --timeout-minutes <n>   Deadline (default: orchestrate.wait.timeout_minutes, 60)
  --interval-seconds <n>  Poll interval (default: orchestrate.wait.interval_seconds, 30)
  --run-dir <path>        Read the config from the run snapshot
  --once                  Check once; status waiting when not met

Output (last stdout line, JSON): { status: done|awaiting-human|failed|waiting,
summary, outputs: { kind, target, deadline, polls, exit_code?, output_tail?,
pr?: { number, url, head } } }

Exit codes: 0 done, awaiting-human (deadline reached) or waiting (--once);
1 failed; 2 usage error.

Environment:
  ESP_GH_CMD              JSON array replacing the gh command (tests)
  ESP_RUNS_NOW            Fixed clock (tests)`;

const BOOLEAN_OPTIONS = new Set(["once", "help"]);
const COMMON = [
  "state",
  "timeout-minutes",
  "interval-seconds",
  "run-dir",
  "once",
  "help"
];
const KNOWN = {
  command: new Set([...COMMON, "run", "cwd"]),
  pr: new Set([...COMMON, "repo", "head", "author", "base", "title"])
};

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (BOOLEAN_OPTIONS.has(key) && eq === -1) {
        options[key] = true;
        continue;
      }
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "")
        throw new WaitForError(`--${key} requires a value`, 2);
      options[key] = value;
    } else positional.push(arg);
  }
  return { command: positional[0], args: positional.slice(1), options };
}

function numberOption(raw, name, min) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min)
    throw new WaitForError(`--${name} must be a number >= ${min}`, 2);
  return value;
}

/**
 * Timeout and interval: the CLI options, else orchestrate.wait.*, else 60
 * minutes and 30 seconds.
 */
export function waitSettings(options, wait = {}) {
  return {
    timeoutMinutes:
      options["timeout-minutes"] !== undefined
        ? numberOption(options["timeout-minutes"], "timeout-minutes", 0)
        : (wait.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES),
    intervalSeconds:
      options["interval-seconds"] !== undefined
        ? numberOption(options["interval-seconds"], "interval-seconds", 1)
        : (wait.interval_seconds ?? DEFAULT_INTERVAL_SECONDS)
  };
}

function waitConfig(options, env) {
  let runDir;
  if (options["run-dir"]) {
    runDir = resolve(expandHome(options["run-dir"]));
    if (!existsSync(runDir) || !statSync(runDir).isDirectory())
      throw new WaitForError(`Run directory not found: ${runDir}`, 2);
  }
  try {
    return loadConfig({ runDir, env }).config.orchestrate?.wait ?? {};
  } catch (err) {
    if (err instanceof ConfigError)
      throw new WaitForError(err.message, err.exitCode ?? 1);
    throw err;
  }
}

function specFor(command, options) {
  if (command === "command") {
    if (!options.run) throw new WaitForError("--run is required", 2);
    return {
      run: options.run,
      cwd: options.cwd ? resolve(expandHome(options.cwd)) : undefined
    };
  }
  if (!options.repo) throw new WaitForError("--repo is required", 2);
  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo))
    throw new WaitForError("--repo must be owner/name", 2);
  if (!options.head && !options.author)
    throw new WaitForError("--head or --author is required", 2);
  if (options.title) {
    try {
      new RegExp(options.title);
    } catch (err) {
      throw new WaitForError(`--title is not a valid regex: ${err.message}`, 2);
    }
  }
  return {
    repo: options.repo,
    head: options.head,
    author: options.author,
    base: options.base,
    title: options.title
  };
}

export async function run(argv, env = process.env, io = {}) {
  const { command, args, options } = parseArgs(argv);
  if (options.help || !command)
    return { output: USAGE, exitCode: command ? 0 : 2 };
  if (!KINDS.includes(command))
    throw new WaitForError(`Unknown command: ${command}\n\n${USAGE}`, 2);
  if (args.length > 0)
    throw new WaitForError(`Unexpected argument: ${args[0]}`, 2);
  for (const key of Object.keys(options))
    if (!KNOWN[command].has(key))
      throw new WaitForError(`Unknown option for ${command}: --${key}`, 2);
  const spec = specFor(command, options);
  const settings = waitSettings(options, waitConfig(options, env));
  const ctx = {
    statePath: options.state ? resolve(expandHome(options.state)) : null,
    exec: io.exec ?? execCommand,
    now: io.now ?? (() => runsNow(env)),
    sleep: io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    log: io.log ?? ((line) => process.stderr.write(`[wait-for] ${line}\n`)),
    client: command === "pr" ? (io.client ?? ghClient(env)) : null
  };
  const block = await waitFor(ctx, command, spec, {
    ...settings,
    once: Boolean(options.once)
  });
  return {
    output: JSON.stringify(block),
    exitCode: block.status === "failed" ? 1 : 0
  };
}

async function main() {
  try {
    const { output, exitCode = 0 } = await run(process.argv.slice(2));
    process.stdout.write(`${output}\n`);
    process.exitCode = exitCode;
  } catch (err) {
    const known =
      err instanceof WaitForError ||
      err.name === "RunsError" ||
      err instanceof ConfigError;
    process.stderr.write(
      `wait-for error: ${known ? err.message : (err.stack ?? err)}\n`
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
