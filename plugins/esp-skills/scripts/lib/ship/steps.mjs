// Step records of esp-ship: the facts each phase step produced (a review
// round, a fix round, the review wait, the merge), kept in the `steps` list of
// ship.json. `ship.mjs record <step>` writes one from the JSON a script
// printed (review.mjs parse, fix-review.mjs outcome, wait-for-review.mjs,
// merge-ready.mjs merge) or from the facts the session gathered. The review
// loop, the pull request loop, the outcome and the pull request body read them.

import { raiseRunRisk, readStdin, now } from "../../runs.mjs";
import {
  parseJsonOption,
  runDirOf,
  SHA,
  ShipError,
  stringOption,
  updateState
} from "./state.mjs";

export const STEP_STATUSES = [
  "done",
  "merged",
  "halted",
  "awaiting-human",
  "failed"
];
const STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RISKS = ["low", "medium", "high"];
const FIELDS = [
  "status",
  "summary",
  "commit",
  "pr",
  "max_risk",
  "blockers",
  "discovered_items",
  "outputs"
];

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Field checks of a step record; returns a list of error strings. */
export function checkStep(record) {
  const errors = [];
  if (!isObject(record)) return ["expected a JSON object"];
  if (!STEP_STATUSES.includes(record.status))
    errors.push(`status: expected one of ${STEP_STATUSES.join(", ")}`);
  if (record.summary !== undefined && typeof record.summary !== "string")
    errors.push("summary: expected a string");
  if (record.commit != null && !SHA.test(String(record.commit)))
    errors.push("commit: expected a commit SHA");
  if (record.max_risk != null && !RISKS.includes(record.max_risk))
    errors.push(`max_risk: expected one of ${RISKS.join(", ")}`);
  if (
    record.blockers !== undefined &&
    !(
      Array.isArray(record.blockers) &&
      record.blockers.every((b) => typeof b === "string")
    )
  )
    errors.push("blockers: expected a list of strings");
  if (
    record.discovered_items !== undefined &&
    !(
      Array.isArray(record.discovered_items) &&
      record.discovered_items.every(isObject)
    )
  )
    errors.push("discovered_items: expected a list of objects");
  if (record.outputs !== undefined && !isObject(record.outputs))
    errors.push("outputs: expected an object");
  return errors;
}

/**
 * `ship.mjs record <step>`: store the facts of a step in ship.json, from
 * --json <object> or stdin. An `outcome` key (review.mjs parse) is unwrapped.
 * Recording a step again replaces it in place.
 */
export function cmdRecord(name, options, env = process.env) {
  const dir = runDirOf(options);
  if (!name || !STEP_NAME.test(name))
    throw new ShipError(
      `Usage: record <step> [--json <facts>]: invalid step name ${name ?? "(missing)"}`,
      2
    );
  const raw = stringOption(options.json) ?? readStdin();
  if (!raw || raw.trim() === "")
    throw new ShipError("record needs the step facts (--json or stdin)", 2);
  const input = parseJsonOption(raw, "json");
  const facts = isObject(input?.outcome) ? input.outcome : input;
  const errors = checkStep(facts);
  if (errors.length > 0)
    throw new ShipError(`Invalid ${name} facts:\n  ${errors.join("\n  ")}`);
  const record = { name };
  for (const key of FIELDS)
    if (facts[key] !== undefined && facts[key] !== null)
      record[key] = facts[key];
  record.at = now(env).toISOString();
  updateState(
    dir,
    (s) => {
      const steps = Array.isArray(s.steps) ? s.steps : [];
      const i = steps.findIndex((r) => r.name === name);
      if (i === -1) steps.push(record);
      else steps[i] = record;
      s.steps = steps;
    },
    env
  );
  raiseRunRisk(dir, record.max_risk, env);
  return record;
}
