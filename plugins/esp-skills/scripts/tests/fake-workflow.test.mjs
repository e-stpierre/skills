import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runWorkflow } from "./helpers/fake-workflow.mjs";

const HELLO = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "workflows",
  "hello.js"
);

const META = 'export const meta = { name: "t", description: "t" };\n';

describe("fake workflow harness", () => {
  test("runs hello.js and records the calls in order", async () => {
    const run = await runWorkflow(HELLO, {
      args: { name: "tests" },
      respond: {
        greet: { greeting: "hello tests" },
        verify: { has_agent: false, has_write: false }
      }
    });
    assert.deepEqual(run.meta, {
      name: "hello",
      description:
        "Test fixture: a default agent and a plugin agent type, both with a schema",
      phases: [{ title: "Greet" }, { title: "Verify" }]
    });
    assert.deepEqual(
      run.calls.map((c) => [c.index, c.label, c.phase]),
      [
        [0, "greet", "Greet"],
        [1, "verify", "Verify"]
      ]
    );
    assert.equal(run.calls[0].prompt, "Say hello to tests.");
    assert.equal(run.calls[0].opts.agentType, undefined);
    assert.deepEqual(run.calls[0].opts.schema.required, ["greeting"]);
    assert.equal(run.calls[1].opts.agentType, "esp-skills:esp-verifier");
    assert.deepEqual(run.calls[1].opts.schema.required, [
      "has_agent",
      "has_write"
    ]);
    assert.deepEqual(run.phases, ["Greet", "Verify"]);
    assert.deepEqual(run.logs, ["done"]);
    assert.deepEqual(run.result, {
      checks: {
        greeting: "hello tests",
        verifier_ran: true,
        verifier_has_agent: false,
        verifier_has_write: false
      }
    });
  });

  test("a failing agent is caught by the script", async () => {
    const run = await runWorkflow(HELLO, {
      respond: [{ greeting: "hello world" }, new Error("agent died")]
    });
    assert.equal(run.calls[0].prompt, "Say hello to world.");
    assert.deepEqual(run.logs, ["verifier failed: agent died", "done"]);
    assert.equal(run.result.checks.verifier_ran, false);
  });

  test("labels with an array of replies are consumed in order", async () => {
    const source = `${META}
const a = await agent("x", { label: "it" });
const b = await agent("y", { label: "it" });
return [a, b];`;
    const run = await runWorkflow(null, {
      source,
      respond: { it: ["one", (call) => `two:${call.prompt}`] }
    });
    assert.deepEqual(run.result, ["one", "two:y"]);
  });

  test("an unscripted call fails the run", async () => {
    await assert.rejects(
      runWorkflow(null, { source: `${META}await agent("x");` }),
      /no scripted reply for agent call 0/
    );
  });

  test("Date.now, Math.random and an argless new Date throw", async () => {
    for (const expr of ["Date.now()", "Math.random()", "new Date()"]) {
      await assert.rejects(
        runWorkflow(null, { source: `${META}return ${expr};` }),
        /not available in workflow scripts/
      );
    }
    const run = await runWorkflow(null, {
      source: `${META}return new Date(0).toISOString();`
    });
    assert.equal(run.result, "1970-01-01T00:00:00.000Z");
  });

  test("a script without meta or with an import is rejected", async () => {
    await assert.rejects(
      runWorkflow(null, { source: "return 1;" }),
      /must begin with/
    );
    await assert.rejects(
      runWorkflow(null, { source: `${META}import x from "y";` }),
      /may not import/
    );
  });

  test("a schema without an object root is rejected", async () => {
    await assert.rejects(
      runWorkflow(null, {
        source: `${META}await agent("x", { schema: { type: "string" } });`,
        respond: ["x"]
      }),
      /type: 'object'/
    );
  });

  test("parallel and pipeline turn a failure into null", async () => {
    const source = `${META}
const p = await parallel([() => agent("a"), () => agent("b")]);
const q = await pipeline([1, 2], (n) => agent("s" + n), (r, item, i) => r + ":" + item + ":" + i);
return { p, q };`;
    const run = await runWorkflow(null, {
      source,
      respond: (call) =>
        call.prompt === "b" || call.prompt === "s2"
          ? new Error("boom")
          : call.prompt
    });
    assert.deepEqual(run.result, { p: ["a", null], q: ["s1:1:0", null] });
  });

  test("the budget is a hard ceiling in agent calls", async () => {
    const source = `${META}
const out = [];
while (budget.remaining() > 0) out.push(await agent("x"));
return { out, total: budget.total, spent: budget.spent() };`;
    const run = await runWorkflow(null, {
      source,
      budget: 2,
      respond: () => "ok"
    });
    assert.deepEqual(run.result, { out: ["ok", "ok"], total: 2, spent: 2 });
  });
});
