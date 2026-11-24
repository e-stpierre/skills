// Base sync: before the pull request, tell the session when origin/<base>
// moved past the base of the task branch, and record the rebase and the gates
// that follow it. The session runs the rebase and the gates itself; this
// module only detects the move and keeps the outcome in ship.json.

import { now } from "../../runs.mjs";
import {
  git,
  projectDirOf,
  readState,
  runDirOf,
  ShipError,
  skipUnfinished,
  stringOption,
  updateState
} from "./state.mjs";
import { cmdHalt } from "./tail.mjs";

export const BASE_SYNC_RESULTS = ["rebased", "conflict", "pass", "fail"];

/** The checkout the task works in: the task worktree, else the project. */
const workspaceOf = (options, state) =>
  state.worktree ?? projectDirOf(options, state);

/**
 * Compare the base of the task branch with origin/<base> after a fetch:
 * `rebase` when origin/<base> has commits the branch does not have.
 */
export function baseSyncCheck(cwd, base) {
  git(["fetch", "--quiet", "origin", base], cwd);
  const onto = git(["rev-parse", `origin/${base}`], cwd).trim();
  const branchBase = git(["merge-base", "HEAD", `origin/${base}`], cwd).trim();
  const behind = Number(
    git(["rev-list", "--count", `HEAD..origin/${base}`], cwd).trim()
  );
  return {
    action: branchBase === onto ? "none" : "rebase",
    base,
    onto,
    behind,
    branch_base: branchBase
  };
}

function recordBaseSync(dir, options, env) {
  const result = stringOption(options.result);
  if (!BASE_SYNC_RESULTS.includes(result))
    throw new ShipError(
      `--result must be one of ${BASE_SYNC_RESULTS.join(", ")}`,
      2
    );
  const reason = stringOption(options.reason);
  if ((result === "conflict" || result === "fail") && !reason)
    throw new ShipError(`a ${result} result needs --reason <text>`, 2);
  const at = now(env).toISOString();
  const current = readState(dir);
  const cwd = workspaceOf(options, current);
  const baseSha =
    result === "rebased" && current.base
      ? git(["merge-base", "HEAD", `origin/${current.base}`], cwd).trim()
      : null;
  const halt = result === "fail" && current.halt_on.includes("gates-exhausted");
  const state = updateState(
    dir,
    (s) => {
      const previous = s.base_sync ?? { history: [] };
      const entry = { result, reason, at };
      if (baseSha) entry.base_sha = baseSha;
      s.base_sync = {
        ...previous,
        last: entry,
        history: [...(previous.history ?? []), entry]
      };
      if (baseSha) s.base_sha = baseSha;
      if (result === "conflict" || (result === "fail" && !halt)) {
        const unfinished = skipUnfinished(s);
        s.stop = {
          status: result === "conflict" ? "awaiting-human" : "failed",
          reason:
            result === "conflict"
              ? `base sync: rebase conflict: ${reason}`
              : `base sync: gates fail after the rebase: ${reason}`,
          at,
          unfinished
        };
      }
    },
    env
  );
  const out = { action: "recorded", result, base_sync: state.base_sync.last };
  if (baseSha) out.base_sha = baseSha;
  if (halt) {
    out.action = "halt";
    out.halt = cmdHalt(
      {
        ...options,
        key: "gates-exhausted",
        phase: "base-sync",
        reason: `gates fail after the rebase onto origin/${current.base}: ${reason}`
      },
      env
    ).halt;
  } else if (result === "conflict" || result === "fail") {
    out.action = "stop";
    out.stop = state.stop;
  }
  return out;
}

/**
 * `ship.mjs base-sync [--record --result rebased|conflict|pass|fail [--reason]]`:
 * without --record, fetch origin/<base> in the workspace and print
 * { action: none|rebase, base, onto, behind }; with it, record the outcome.
 */
export function cmdBaseSync(options, env = process.env) {
  const dir = runDirOf(options);
  if (options.record) return recordBaseSync(dir, options, env);
  const state = readState(dir);
  if (state.adopted_pr)
    return {
      action: "none",
      reason:
        "adopted pull request: its branch is owned upstream, no rebase before the review wait"
    };
  if (!state.base)
    throw new ShipError("base-sync needs the base branch recorded at init");
  return baseSyncCheck(workspaceOf(options, state), state.base);
}
