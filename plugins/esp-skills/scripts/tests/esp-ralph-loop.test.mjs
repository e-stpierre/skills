import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runWorkflow } from "./helpers/fake-workflow.mjs";

const LOOP = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "workflows",
  "esp-ralph-loop.js"
);

const SHA = (n) => String(n).repeat(40).slice(0, 40);

const step = (n, extra = {}) => ({
  status: "continue",
  summary: `unit ${n} done`,
  commits: [SHA(n)],
  progress_note: `unit ${n} finished`,
  ...extra
});

describe("esp-ralph-loop workflow", () => {
  test("completes on iteration 3 and creates the run on iteration 1", async () => {
    const run = await runWorkflow(LOOP, {
      args: { task: "C:/runs/2026-11-16-x/prompt.md", max_iterations: 5 },
      respond: [
        step(1, { run_dir: "C:/runs/2026-11-16-x" }),
        step(2),
        step(3, { status: "complete" })
      ]
    });
    assert.equal(run.meta.name, "esp-ralph-loop");
    assert.equal(run.result.reason, "complete");
    assert.equal(run.result.blocker, null);
    assert.equal(run.result.run_dir, "C:/runs/2026-11-16-x");
    assert.deepEqual(
      run.result.iterations.map((it) => [it.n, it.status]),
      [
        [1, "continue"],
        [2, "continue"],
        [3, "complete"]
      ]
    );
    assert.deepEqual(run.result.commits, [SHA(1), SHA(2), SHA(3)]);
    assert.equal(run.calls.length, 3);
    assert.deepEqual(
      run.calls.map((c) => [c.label, c.phase, c.opts.agentType]),
      [
        ["iteration-1", "Iterate", "esp-skills:esp-iterator"],
        ["iteration-2", "Iterate", "esp-skills:esp-iterator"],
        ["iteration-3", "Iterate", "esp-skills:esp-iterator"]
      ]
    );
    assert.deepEqual(run.calls[0].opts.schema.properties.status.enum, [
      "continue",
      "complete",
      "blocked"
    ]);
    assert.match(
      run.calls[0].prompt,
      /Task file: C:\/runs\/2026-11-16-x\/prompt\.md/
    );
    assert.match(run.calls[0].prompt, /Run dir: none yet/);
    assert.match(run.calls[0].prompt, /--workflow esp-ralph/);
    assert.match(run.calls[1].prompt, /Run dir: C:\/runs\/2026-11-16-x/);
    assert.match(run.calls[1].prompt, /iteration 2 of at most 5/);
    for (const call of run.calls) assert.match(call.prompt, /\(operator\)/);
    assert.equal(run.logs.length, 4);
    assert.match(run.logs.at(-1), /loop ended: complete after 3/);
  });

  test("stops at max_iterations", async () => {
    const run = await runWorkflow(LOOP, {
      args: { task: "Fix every lint warning", max_iterations: 2 },
      respond: (call) => step(call.index + 1)
    });
    assert.equal(run.result.reason, "max_iterations");
    assert.equal(run.calls.length, 2);
    assert.match(run.calls[0].prompt, /Task:\n\nFix every lint warning/);
  });

  test("defaults to 25 iterations", async () => {
    const run = await runWorkflow(LOOP, {
      args: { task: "t" },
      respond: (call) => step(call.index + 1)
    });
    assert.equal(run.calls.length, 25);
    assert.equal(run.result.reason, "max_iterations");
  });

  test("stops on blocked and returns the blocker", async () => {
    const run = await runWorkflow(LOOP, {
      args: { task: "t", run_dir: "/r" },
      respond: [
        step(1),
        {
          status: "blocked",
          summary: "operator asked to stop",
          commits: [],
          progress_note: "",
          blocker: "Operator: stop after M2"
        },
        step(3)
      ]
    });
    assert.equal(run.result.reason, "blocked");
    assert.equal(run.result.blocker, "Operator: stop after M2");
    assert.equal(run.result.run_dir, "/r");
    assert.equal(run.calls.length, 2);
    assert.match(run.calls[0].prompt, /Run dir: \/r/);
  });

  test("stops after two iterations without commits or notes", async () => {
    const idle = { ...step(0), commits: [], progress_note: "" };
    const run = await runWorkflow(LOOP, {
      args: { task: "t" },
      respond: [
        step(1),
        idle,
        { ...idle, progress_note: "tried X" },
        idle,
        idle,
        step(6)
      ]
    });
    assert.equal(run.result.reason, "no_progress");
    assert.equal(run.calls.length, 5);
  });

  test("no_progress_limit is configurable", async () => {
    const idle = { ...step(0), commits: [], progress_note: "" };
    const run = await runWorkflow(LOOP, {
      args: { task: "t", no_progress_limit: 1 },
      respond: [step(1), idle, step(3)]
    });
    assert.equal(run.result.reason, "no_progress");
    assert.equal(run.calls.length, 2);
  });

  test("stops after two null results in a row, and a thrown agent counts as null", async () => {
    const run = await runWorkflow(LOOP, {
      args: { task: "t" },
      respond: [null, step(2), null, new Error("api died"), step(5)]
    });
    assert.equal(run.result.reason, "agent_failures");
    assert.equal(run.calls.length, 4);
    assert.deepEqual(
      run.result.iterations.map((it) => it.status),
      [null, "continue", null, null]
    );
    assert.ok(run.logs.some((l) => /agent error: api died/.test(l)));
  });

  test("uses general-purpose only with allow_subagents: true", async () => {
    const types = async (extra) =>
      (
        await runWorkflow(LOOP, {
          args: { task: "t", max_iterations: 1, ...extra },
          respond: [step(1)]
        })
      ).calls[0].opts.agentType;
    assert.equal(await types({}), "esp-skills:esp-iterator");
    assert.equal(
      await types({ allow_subagents: "true" }),
      "esp-skills:esp-iterator"
    );
    assert.equal(
      await types({ allow_subagents: true, plugin_root: "C:/p" }),
      "general-purpose"
    );
  });

  test("points general-purpose iterations at the iterator rules", async () => {
    const prompt = async (extra) =>
      (
        await runWorkflow(LOOP, {
          args: { task: "t", max_iterations: 1, ...extra },
          respond: [step(1)]
        })
      ).calls[0].prompt;
    const general = await prompt({
      allow_subagents: true,
      plugin_root: "C:/p"
    });
    assert.match(general, /read C:\/p\/agents\/esp-iterator\.md in full/);
    assert.match(general, /\$\{CLAUDE_PLUGIN_ROOT\} is C:\/p/);
    assert.doesNotMatch(await prompt({}), /esp-iterator\.md/);
    await assert.rejects(
      runWorkflow(LOOP, {
        args: { task: "t", allow_subagents: true },
        respond: []
      }),
      /args\.plugin_root is required/
    );
  });

  test("passes model and effort to every iteration", async () => {
    const run = await runWorkflow(LOOP, {
      args: { task: "t", max_iterations: 2, model: "sonnet", effort: "high" },
      respond: (call) => step(call.index + 1)
    });
    for (const call of run.calls) {
      assert.equal(call.opts.model, "sonnet");
      assert.equal(call.opts.effort, "high");
    }
    const bare = await runWorkflow(LOOP, {
      args: { task: "t", max_iterations: 1 },
      respond: [step(1)]
    });
    assert.equal("model" in bare.calls[0].opts, false);
    assert.equal("effort" in bare.calls[0].opts, false);
  });

  test("accepts a plain string as the task, and rejects a missing task", async () => {
    const run = await runWorkflow(LOOP, {
      args: "Write the docs",
      respond: [step(1, { status: "complete" })]
    });
    assert.match(run.calls[0].prompt, /Task:\n\nWrite the docs/);
    await assert.rejects(
      runWorkflow(LOOP, { args: {}, respond: [] }),
      /args\.task is required/
    );
  });
});
