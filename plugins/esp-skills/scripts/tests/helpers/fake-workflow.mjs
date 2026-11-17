// Run a Workflow tool script under node:vm with scripted agents, for tests.
//
// The script gets the same globals as under Claude Code (agent, parallel,
// pipeline, phase, log, args, budget, workflow), and the same restrictions:
// Date.now(), Math.random() and an argless new Date() throw, and there is no
// require, import or process. Every agent() call is recorded.
//
// Usage:
//   const run = await runWorkflow("workflows/esp-ralph-loop.js", {
//     args: { task: "..." },
//     respond: { greet: { greeting: "hi" } }
//   });
//   run.result, run.calls, run.logs, run.phases, run.meta
//
// `respond` scripts the agent replies, one of:
// - a function `(call) => value` (may be async)
// - an array: one entry per agent() call, in call order
// - an object keyed by label: a value, or an array consumed one per call
// An entry that is a function is called with the call; an Error is thrown
// from agent(), like a failed subagent; `undefined` means the agent was not
// scripted, which fails the call.
//
// `budget` (optional) is counted in agent calls, not tokens: once that many
// calls have returned, agent() throws, like the real hard ceiling.

import { readFileSync } from "node:fs";
import vm from "node:vm";

const PRELUDE = `
"use strict";
{
  const RealDate = Date;
  const blocked = (name) => () => {
    throw new Error(name + " is not available in workflow scripts");
  };
  RealDate.now = blocked("Date.now()");
  Math.random = blocked("Math.random()");
  globalThis.Date = new Proxy(RealDate, {
    construct(target, list, newTarget) {
      if (list.length === 0) blocked("new Date()")();
      return Reflect.construct(target, list, newTarget);
    },
    apply() {
      blocked("Date()")();
    }
  });
}
`;

/** Check the shape the real agent() requires of a schema. */
export function checkSchema(schema) {
  if (
    !schema ||
    schema.type !== "object" ||
    typeof schema.properties !== "object"
  ) {
    throw new Error(
      "schema needs { type: 'object', properties: {...} } at its root"
    );
  }
  for (const key of schema.required ?? []) {
    if (!(key in schema.properties)) {
      throw new Error(`schema requires "${key}", which is not in properties`);
    }
  }
}

/** Turn the source of a workflow file into an async function body. */
export function toBody(source) {
  const marker = /^export\s+const\s+meta\s*=/m;
  if (!marker.test(source)) {
    throw new Error(
      "workflow script must begin with `export const meta = {...}`"
    );
  }
  if (/^\s*(import|export)\b/m.test(source.replace(marker, ""))) {
    throw new Error(
      "workflow script may not import or export anything but meta"
    );
  }
  return source.replace(marker, "const meta = __meta.value =");
}

function pickResponse(respond, call, counters) {
  if (typeof respond === "function") return respond(call);
  if (Array.isArray(respond)) return respond[call.index];
  if (respond && call.label in respond) {
    const entry = respond[call.label];
    if (!Array.isArray(entry)) return entry;
    const n = counters.get(call.label) ?? 0;
    counters.set(call.label, n + 1);
    return entry[n];
  }
  return undefined;
}

/** Copy a value out of the vm realm so assert.deepStrictEqual compares it. */
function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * Run a workflow file (or source text with `source`) and return its result,
 * meta, the recorded agent calls, the log lines and the phases started.
 */
export async function runWorkflow(
  file,
  { args, respond = {}, budget = null, source, workflows = {} } = {}
) {
  const text = source ?? readFileSync(file, "utf8");
  const calls = [];
  const logs = [];
  const phases = [];
  const counters = new Map();
  let current = null;
  let spent = 0;

  async function agent(prompt, opts = {}) {
    if (typeof prompt !== "string")
      throw new Error("agent() needs a prompt string");
    if (opts.schema) checkSchema(opts.schema);
    if (budget !== null && spent >= budget) {
      throw new Error("token budget exhausted");
    }
    const call = {
      index: calls.length,
      prompt,
      label: opts.label ?? null,
      phase: opts.phase ?? current,
      opts: clone(opts)
    };
    calls.push(call);
    let reply = pickResponse(respond, call, counters);
    if (typeof reply === "function") reply = await reply(call);
    else reply = await reply;
    if (reply instanceof Error) throw reply;
    if (reply === undefined) {
      throw new Error(
        `no scripted reply for agent call ${call.index} (${call.label ?? "no label"})`
      );
    }
    spent += 1;
    return reply;
  }

  async function parallel(thunks) {
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      })
    );
  }

  async function pipeline(items, ...stages) {
    return Promise.all(
      items.map(async (item, index) => {
        let value = item;
        try {
          for (const stage of stages) value = await stage(value, item, index);
          return value;
        } catch {
          return null;
        }
      })
    );
  }

  async function workflow(name, childArgs) {
    if (!(name in workflows)) throw new Error(`unknown workflow: ${name}`);
    return workflows[name](childArgs);
  }

  const meta = { value: undefined };
  const context = vm.createContext({
    __meta: meta,
    agent,
    parallel,
    pipeline,
    workflow,
    phase: (title) => {
      current = title;
      phases.push(title);
    },
    log: (message) => logs.push(String(message)),
    args: clone(args),
    budget: {
      total: budget,
      spent: () => spent,
      remaining: () =>
        budget === null ? Infinity : Math.max(0, budget - spent)
    }
  });
  vm.runInContext(PRELUDE, context);
  const run = vm.runInContext(
    `(async () => {\n${toBody(text)}\n})()`,
    context,
    { filename: file ?? "workflow.js" }
  );
  const result = await run;
  return {
    result: clone(result),
    meta: clone(meta.value),
    calls,
    logs,
    phases
  };
}
