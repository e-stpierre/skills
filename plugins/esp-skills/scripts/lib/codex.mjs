// Codex CLI adapter for codex.mjs: the one place that knows the `codex exec`
// flags, its JSONL events and its error messages, so a Codex CLI change is
// fixed here only.
//
// Targets Codex CLI 0.128.0: `codex exec --json -o <file> -s <sandbox>
// -C <dir> [-m <model>] [--output-schema <file>] -c approval_policy="never" -`,
// with the prompt on stdin. `codex exec` never asks for approval, and the
// `approval_policy="never"` override makes a command outside the sandbox fail
// instead of waiting.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export const MIN_VERSION = "0.128.0";
export const SANDBOXES = ["read-only", "workspace-write"];
export const DEFAULT_SANDBOX = "read-only";
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const APPROVAL_OVERRIDE = 'approval_policy="never"';
const STDERR_TAIL = 4000;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * The Codex command as `[file, ...prefix args]`. `ESP_CODEX_CMD` (a JSON
 * array) replaces it, for tests. On Windows the npm `codex.cmd` shim cannot be
 * spawned without a shell, so its `codex.js` entry point runs on this Node.
 */
export function codexCommand(env = process.env, platform = process.platform) {
  if (env.ESP_CODEX_CMD) {
    const cmd = JSON.parse(env.ESP_CODEX_CMD);
    if (!Array.isArray(cmd) || cmd.length === 0)
      throw new Error("ESP_CODEX_CMD must be a non-empty JSON array");
    return cmd.map(String);
  }
  if (platform === "win32") {
    for (const dir of String(env.PATH ?? env.Path ?? "").split(delimiter)) {
      if (!dir || !existsSync(join(dir, "codex.cmd"))) continue;
      const entry = join(
        dir,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js"
      );
      if (existsSync(entry)) return [process.execPath, entry];
    }
  }
  return ["codex"];
}

/** `codex exec` arguments; the prompt is read from stdin (`-`). */
export function execArgs({ out, sandbox, cwd, model, schema, gitCheck }) {
  if (!SANDBOXES.includes(sandbox))
    throw new Error(
      `Unknown sandbox "${sandbox}" (expected ${SANDBOXES.join(" or ")})`
    );
  const args = ["exec", "--json", "-o", out, "-s", sandbox, "-C", cwd];
  args.push("-c", APPROVAL_OVERRIDE);
  if (model) args.push("-m", model);
  if (schema) args.push("--output-schema", schema);
  if (gitCheck === false) args.push("--skip-git-repo-check");
  args.push("-");
  return args;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The readable message of a Codex error, unwrapping the API error JSON it often holds. */
export function errorMessage(raw) {
  let text = typeof raw === "string" ? raw : (raw?.message ?? "");
  for (let i = 0; i < 3; i++) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      break;
    }
    const inner = parsed?.error?.message ?? parsed?.message;
    if (typeof inner !== "string") break;
    text = inner;
  }
  return String(text).trim();
}

/**
 * Read a `codex exec --json` stream: summed usage of every `turn.completed`,
 * the last agent message, the thread ID and the first error.
 */
export function parseEvents(text) {
  const usage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0
  };
  let turns = 0;
  let threadId = null;
  let lastMessage = null;
  let error = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    switch (event.type) {
      case "thread.started":
        threadId = event.thread_id ?? threadId;
        break;
      case "turn.completed":
        turns++;
        for (const key of Object.keys(usage)) {
          const n = Number(event.usage?.[key]);
          if (Number.isFinite(n)) usage[key] += n;
        }
        break;
      case "turn.failed":
        error ??= errorMessage(event.error);
        break;
      case "error":
        error ??= errorMessage(event.message ?? event.error);
        break;
      case "item.completed":
        if (event.item?.type === "agent_message" && event.item.text)
          lastMessage = event.item.text;
        break;
      default:
        break;
    }
  }
  return { usage, turns, threadId, lastMessage, error };
}

/** What a Codex failure means and the fix to try. */
export function classifyFailure(message) {
  const text = String(message ?? "");
  if (/model_not_found|model is not supported|unknown model/i.test(text))
    return {
      kind: "model",
      fix: "pass --model with a model your Codex plan supports, or set `model` in ~/.codex/config.toml"
    };
  if (
    /not logged in|login|unauthori[sz]ed|401|auth(entication)? (failed|required)|token (expired|invalid)/i.test(
      text
    )
  )
    return { kind: "login", fix: "run `codex login`" };
  if (/usage limit|rate limit|429/i.test(text))
    return { kind: "limit", fix: "wait for the Codex usage limit to reset" };
  if (/ENOENT|not found|not recognized/i.test(text))
    return {
      kind: "missing",
      fix: `install the Codex CLI ${MIN_VERSION} or later: npm i -g @openai/codex`
    };
  return { kind: "other", fix: null };
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** The `x.y.z` version in `codex --version` output, or null. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Compare two `x.y.z` versions: negative, 0 or positive. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** Kill a process and its children (`taskkill /T /F` on Windows, the process group elsewhere). */
export function killTree(pid, platform = process.platform) {
  if (!pid) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Whether a process is still running. */
export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Run a command with `input` on stdin and a time limit; on timeout the whole
 * process tree is killed. Resolves `{ code, stdout, stderr, timedOut, error }`.
 */
export function runProcess(
  cmd,
  args,
  { cwd, env = process.env, input = "", timeoutMs, onSpawn } = {}
) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr: stderr.slice(-STDERR_TAIL),
        timedOut,
        ...result
      });
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
          }, timeoutMs)
        : null;
    if (onSpawn && child.pid) onSpawn(child.pid);
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => {
      stderr += d;
      if (stderr.length > STDERR_TAIL * 4) stderr = stderr.slice(-STDERR_TAIL);
    });
    child.on("error", (error) => finish({ code: null, error }));
    child.on("close", (code) => finish({ code, error: null }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
