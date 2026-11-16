// Field checks for the run directory files that runs.mjs writes and checks:
// run.json, one decisions.jsonl entry, and the summary.md frontmatter.
// Each check returns a list of `{ path, message }` errors; unknown fields are
// allowed, so a writer can add a field without changing these checks.

import { RISK_ORDER } from "./risk.mjs";

export const RUN_TYPES = ["skill", "workflow"];

export const RUN_STATUSES = [
  "queued",
  "running",
  "paused",
  "blocked",
  "awaiting-human",
  "halted",
  "failed",
  "canceled",
  "done",
  "merged"
];

export const TERMINAL_RUN_STATUSES = [
  "halted",
  "failed",
  "canceled",
  "done",
  "merged"
];

export const DECISION_SOURCES = ["agent", "operator", "policy"];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

const show = (value) =>
  value === undefined ? "undefined" : JSON.stringify(value);

/** A small rule set: each rule checks one field and pushes its errors. */
function checker(value) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  const isObject =
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject) {
    fail("(root)", `expected an object, got ${show(value)}`);
    return { errors, field: () => ({}) };
  }
  const field = (key, { required = false, nullable = false } = {}) => {
    const v = value[key];
    const present = v !== undefined && !(nullable && v === null);
    if (v === undefined && required) fail(key, "is required");
    const rule = (ok, message) => {
      if (present && !ok(v)) fail(key, `${message}, got ${show(v)}`);
      return rules;
    };
    const rules = {
      oneOf: (list) =>
        rule(
          (x) => list.includes(x),
          `expected one of ${list.map(show).join(", ")}`
        ),
      text: () =>
        rule(
          (x) => typeof x === "string" && x.length > 0,
          "expected a non-empty string"
        ),
      id: () =>
        rule(
          (x) => typeof x === "string" && ID_PATTERN.test(x),
          "expected an ID (letters, digits, dot, underscore, dash)"
        ),
      timestamp: () =>
        rule(
          (x) =>
            typeof x === "string" &&
            TIMESTAMP_PATTERN.test(x) &&
            !Number.isNaN(Date.parse(x)),
          "expected an RFC 3339 date-time"
        ),
      sha: () =>
        rule(
          (x) => typeof x === "string" && SHA_PATTERN.test(x),
          "expected a commit SHA"
        ),
      list: () =>
        rule(
          (x) =>
            Array.isArray(x) &&
            x.every((i) => typeof i === "string" && i.length > 0),
          "expected a list of non-empty strings"
        ),
      count: () =>
        rule((x) => Number.isInteger(x) && x >= 0, "expected an integer >= 0"),
      amount: () =>
        rule((x) => typeof x === "number" && x >= 0, "expected a number >= 0"),
      object: (each) =>
        rule(
          (x) =>
            x !== null &&
            typeof x === "object" &&
            !Array.isArray(x) &&
            Object.values(x).every(each),
          "expected an object of valid entries"
        )
    };
    return rules;
  };
  return { errors, field };
}

const RUN_TEXT_FIELDS = [
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

/** Check a run.json value. */
export function checkRun(run) {
  const { errors, field } = checker(run);
  field("id", { required: true }).id();
  field("type", { required: true }).oneOf(RUN_TYPES);
  field("status", { required: true }).oneOf(RUN_STATUSES);
  field("started_at", { required: true }).timestamp();
  field("updated_at").timestamp();
  field("ended_at", { nullable: true }).timestamp();
  field("max_risk", { nullable: true }).oneOf(RISK_ORDER);
  for (const key of RUN_TEXT_FIELDS) field(key, { nullable: true }).text();
  field("models").object(
    (m) =>
      m !== null &&
      typeof m === "object" &&
      typeof m.model === "string" &&
      m.model.length > 0 &&
      (m.effort === undefined ||
        (typeof m.effort === "string" && m.effort.length > 0))
  );
  field("budgets_used").object((n) => typeof n === "number" && n >= 0);
  return errors;
}

/** Check one decisions.jsonl entry. */
export function checkDecision(entry) {
  const { errors, field } = checker(entry);
  field("id", { required: true }).id();
  field("at", { required: true }).timestamp();
  field("phase", { required: true }).text();
  field("source", { required: true }).oneOf(DECISION_SOURCES);
  field("risk", { required: true }).oneOf(RISK_ORDER);
  field("decision", { required: true }).text();
  field("rationale", { required: true }).text();
  field("alternatives").list();
  field("files").list();
  field("refs").list();
  field("commit", { nullable: true }).sha();
  return errors;
}

/** Check the frontmatter of a summary.md. */
export function checkSummary(frontmatter) {
  const { errors, field } = checker(frontmatter);
  field("task", { required: true }).id();
  field("title", { required: true }).text();
  field("status", { required: true }).oneOf([...RUN_STATUSES, "escalate"]);
  field("workflow", { nullable: true }).text();
  field("pr", { nullable: true }).text();
  field("max_risk", { nullable: true }).oneOf(RISK_ORDER);
  field("decisions").count();
  field("critical_findings").count();
  field("duration_minutes", { nullable: true }).amount();
  return errors;
}

/** The check of each run file kind, by kind name. */
export const CHECKS = {
  run: checkRun,
  decision: checkDecision,
  summary: checkSummary
};
