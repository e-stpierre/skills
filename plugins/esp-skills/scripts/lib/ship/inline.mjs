// The inline track: the escalation limits (files changed, gate failures) and
// the move to the orchestrated track, an in-place track switch: the branch and
// the uncommitted work stay.

import { appendDecision, now } from "../../runs.mjs";
import { applyTrack } from "./phases.mjs";
import {
  changedFiles,
  configOf,
  ESCALATION_TRIGGERS,
  projectDirOf,
  readState,
  runDirOf,
  ShipError,
  stringOption,
  updateState
} from "./state.mjs";

function escalationAction(state) {
  return state.escalate ? "escalate" : "continue-over-limit";
}

/** Compare the changed files (or an estimate) with the inline max_files_changed. */
export function scopeCheck(state, files, estimate = null) {
  const count = estimate ?? files.length;
  const exceeded = count > state.max_files_changed;
  const action = exceeded ? escalationAction(state) : "continue";
  const out = {
    files,
    count: files.length,
    estimate,
    max_files_changed: state.max_files_changed,
    exceeded,
    action
  };
  return out;
}

export function cmdScope(options) {
  const dir = runDirOf(options);
  const state = readState(dir);
  let estimate = null;
  if (options.estimate !== undefined) {
    estimate = Number(options.estimate);
    if (!Number.isInteger(estimate) || estimate < 0)
      throw new ShipError("--estimate must be an integer >= 0", 2);
  }
  const files =
    estimate === null
      ? changedFiles(projectDirOf(options, state), state.base_sha)
      : [];
  return scopeCheck(state, files, estimate);
}

/** Count a gate failure. The second one escalates (or halts when escalation is off). */
export function gateFailureAction(state) {
  if (state.gate_failures < state.gate_failure_limit) return "retry";
  return state.escalate ? "escalate" : "halt";
}

export function cmdGateFailure(options, env = process.env) {
  const dir = runDirOf(options);
  const state = updateState(
    dir,
    (s) => {
      s.gate_failures += 1;
      if (stringOption(options.reason))
        s.gate_failure_reasons = [
          ...(s.gate_failure_reasons ?? []),
          String(options.reason)
        ];
    },
    env
  );
  const action = gateFailureAction(state);
  const out = {
    gate_failures: state.gate_failures,
    limit: state.gate_failure_limit,
    action
  };
  return out;
}

function escalationInput(options) {
  const trigger = options.trigger;
  if (!ESCALATION_TRIGGERS.includes(trigger))
    throw new ShipError(
      `--trigger must be one of ${ESCALATION_TRIGGERS.join(", ")}`,
      2
    );
  const reason = stringOption(options.reason);
  if (!reason) throw new ShipError("escalating needs --reason <text>", 2);
  return { trigger, reason };
}

function assertInline(state, command) {
  if (state.track !== "inline")
    throw new ShipError(
      `${command}: the run is on the ${state.track} track, not inline`
    );
}

function logEscalation(dir, state, { trigger, reason, files, decision }, env) {
  return appendDecision(
    dir,
    {
      phase:
        state.phase_status.implement === "pending" ? "context" : "implement",
      source: trigger === "design" ? "agent" : "policy",
      risk: "medium",
      decision,
      rationale: `Escalate: ${reason}`,
      files,
      "x-esp-escalation": trigger
    },
    env
  );
}

/**
 * Switch an inline run to the orchestrated track, in place: the branch,
 * the commits and the uncommitted work stay, the phases both tracks share keep
 * their progress, and the orchestrated phases start from the plan.
 */
export function cmdSwitchTrack(options, env = process.env) {
  const dir = runDirOf(options);
  const state = readState(dir);
  const to = stringOption(options.to) ?? "orchestrated";
  if (to !== "orchestrated")
    throw new ShipError(
      "--to must be orchestrated (inline -> orchestrated)",
      2
    );
  const { trigger, reason } = escalationInput(options);
  assertInline(state, "switch-track");
  const files = changedFiles(projectDirOf(options, state), state.base_sha);
  const decision = logEscalation(
    dir,
    state,
    {
      trigger,
      reason,
      files,
      decision: `Switch to the orchestrated track (${trigger})`
    },
    env
  );
  const at = now(env).toISOString();
  const updated = updateState(
    dir,
    (s) => {
      s.track_history = [
        ...(s.track_history ?? []),
        {
          from: "inline",
          to,
          trigger,
          reason,
          decision: decision.id,
          at,
          phase_status: s.phase_status
        }
      ];
      s.escalated_from = {
        track: "inline",
        trigger,
        reason,
        files,
        decision: decision.id
      };
      applyTrack(s, to, configOf(s.config_snapshot));
    },
    env
  );
  return {
    track: updated.track,
    from: "inline",
    trigger,
    decision: decision.id,
    files,
    phases: updated.phases,
    phase_status: updated.phase_status,
    next: updated.phases.find((p) =>
      ["pending", "started"].includes(updated.phase_status[p])
    )
  };
}
