import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cmdDoctor,
  cmdReview,
  cmdRun,
  cmdWait,
  normalizeFindings,
  readPrompt,
  reviewSchema
} from "../codex.mjs";
import {
  APPROVAL_OVERRIDE,
  classifyFailure,
  codexCommand,
  compareVersions,
  errorMessage,
  execArgs,
  isAlive,
  parseEvents,
  parseVersion
} from "../lib/codex.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "codex.mjs");
const FAKE = join(HERE, "helpers", "fake-codex.mjs");
const MODEL_ERROR = JSON.stringify({
  type: "error",
  status: 400,
  error: {
    type: "invalid_request_error",
    message:
      "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
    code: "model_not_found"
  }
});
const USAGE_EVENT = {
  type: "turn.completed",
  usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 40 }
};

let dir;
let record;

function scenario(spec) {
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify({ record, ...spec }));
  return {
    ...process.env,
    ESP_CODEX_CMD: JSON.stringify([process.execPath, FAKE]),
    ESP_FAKE_CODEX: file
  };
}

function calls() {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

function makeRunDir() {
  const runDir = join(dir, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({
      id: "2026-11-16-codex",
      task: "codex",
      title: "Codex",
      type: "skill",
      status: "running",
      started_at: "2026-11-16T10:00:00.000Z",
      updated_at: "2026-11-16T10:00:00.000Z"
    })
  );
  return runDir;
}

async function waitDead(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "esp-codex-test-"));
  record = join(dir, "calls.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lib/codex", () => {
  test("exec args carry the sandbox, the approval override and stdin", () => {
    const args = execArgs({
      out: "o.md",
      sandbox: "workspace-write",
      cwd: "/repo",
      model: "m1",
      schema: "s.json",
      gitCheck: false
    });
    assert.deepEqual(args, [
      "exec",
      "--json",
      "-o",
      "o.md",
      "-s",
      "workspace-write",
      "-C",
      "/repo",
      "-c",
      APPROVAL_OVERRIDE,
      "-m",
      "m1",
      "--output-schema",
      "s.json",
      "--skip-git-repo-check",
      "-"
    ]);
    assert.equal(APPROVAL_OVERRIDE, 'approval_policy="never"');
    assert.throws(() =>
      execArgs({ out: "o", sandbox: "danger-full-access", cwd: "." })
    );
  });

  test("parseEvents sums usage and keeps the last message and the first error", () => {
    const text = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      "not json",
      JSON.stringify(USAGE_EVENT),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hi" }
      }),
      JSON.stringify({
        ...USAGE_EVENT,
        usage: { input_tokens: 10, output_tokens: 2 }
      }),
      JSON.stringify({ type: "error", message: MODEL_ERROR }),
      JSON.stringify({ type: "turn.failed", error: { message: "second" } })
    ].join("\n");
    const events = parseEvents(text);
    assert.equal(events.threadId, "t1");
    assert.equal(events.turns, 2);
    assert.deepEqual(events.usage, {
      input_tokens: 1210,
      cached_input_tokens: 800,
      output_tokens: 42,
      reasoning_output_tokens: 0
    });
    assert.equal(events.lastMessage, "hi");
    assert.match(events.error, /^The 'gpt-5.5' model is not supported/);
  });

  test("errors are unwrapped and classified with a fix", () => {
    assert.equal(
      errorMessage({ message: MODEL_ERROR }).startsWith("The 'gpt-5.5'"),
      true
    );
    assert.equal(classifyFailure(errorMessage(MODEL_ERROR)).kind, "model");
    assert.equal(classifyFailure("Not logged in").kind, "login");
    assert.match(classifyFailure("Not logged in").fix, /codex login/);
    assert.equal(classifyFailure("something odd").fix, null);
  });

  test("versions parse and compare", () => {
    assert.equal(parseVersion("codex-cli 0.128.0\n"), "0.128.0");
    assert.equal(parseVersion("garbage"), null);
    assert.ok(compareVersions("0.128.0", "0.128.0") === 0);
    assert.ok(compareVersions("0.99.9", "0.128.0") < 0);
    assert.ok(compareVersions("1.0.0", "0.128.0") > 0);
  });

  test("ESP_CODEX_CMD replaces the executable", () => {
    assert.deepEqual(codexCommand({ ESP_CODEX_CMD: '["node","x.mjs"]' }), [
      "node",
      "x.mjs"
    ]);
    assert.deepEqual(codexCommand({ PATH: "" }, "linux"), ["codex"]);
    assert.throws(() => codexCommand({ ESP_CODEX_CMD: "[]" }));
  });
});

describe("run", () => {
  test("done returns the last message and the usage", async () => {
    const env = scenario({
      exec: {
        events: [
          { type: "thread.started", thread_id: "t9" },
          {
            type: "item.completed",
            item: { type: "agent_message", text: "The answer" }
          },
          USAGE_EVENT
        ],
        last_message: "The answer\n\nmore detail"
      }
    });
    const out = join(dir, "last.md");
    const result = await cmdRun(
      { prompt: "List the files", cwd: dir, out },
      env
    );
    assert.equal(result.status, "done");
    assert.equal(result.summary, "The answer");
    assert.equal(result.out, out);
    assert.equal(readFileSync(out, "utf8"), "The answer\n\nmore detail");
    assert.equal(result.usage.input_tokens, 1200);
    assert.equal(result.exit_code, 0);
    assert.equal(result.thread_id, "t9");
    const [call] = calls();
    assert.equal(call.stdin, "List the files");
    assert.deepEqual(call.argv.slice(0, 6), [
      "exec",
      "--json",
      "-o",
      out,
      "-s",
      "read-only"
    ]);
    assert.ok(call.argv.includes(APPROVAL_OVERRIDE));
    // dir is not a git repository
    assert.ok(call.argv.includes("--skip-git-repo-check"));
  });

  test("the prompt can come from a file", async () => {
    const env = scenario({ exec: { last_message: "ok" } });
    const file = join(dir, "task.md");
    writeFileSync(file, "Task from a file");
    await cmdRun({ prompt: `@${file}`, cwd: dir, out: join(dir, "o.md") }, env);
    assert.equal(calls()[0].stdin, "Task from a file");
  });

  test("the prompt can come from stdin with --prompt -", () => {
    const env = scenario({ exec: { last_message: "ok" } });
    const res = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "run",
        "--prompt",
        "-",
        "--cwd",
        dir,
        "--out",
        join(dir, "o.md")
      ],
      { encoding: "utf8", env, input: "Task from stdin" }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(calls()[0].stdin, "Task from stdin");
    assert.throws(() => readPrompt("-", () => "  \n"), /stdin holds no prompt/);
  });

  test("a Codex error returns failed with the error and its fix", async () => {
    const env = scenario({
      exec: {
        events: [
          { type: "error", message: MODEL_ERROR },
          { type: "turn.failed", error: { message: MODEL_ERROR } }
        ],
        last_message: null,
        exit_code: 1
      }
    });
    const result = await cmdRun(
      { prompt: "x", cwd: dir, out: join(dir, "o.md") },
      env
    );
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "codex");
    assert.match(result.error, /model is not supported/);
    assert.equal(result.failure, "model");
    assert.match(result.fix, /--model/);
    assert.equal(result.exit_code, 1);
  });

  test("a non-zero exit without events uses the last stderr line", async () => {
    const env = scenario({
      exec: { exit_code: 3, stderr: "fatal: boom", last_message: null }
    });
    const result = await cmdRun(
      { prompt: "x", cwd: dir, out: join(dir, "o.md") },
      env
    );
    assert.equal(result.status, "failed");
    assert.equal(result.error, "fatal: boom");
  });

  test("a timeout kills the whole process tree", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const env = scenario({
      exec: { hang: true, grandchild_pid_file: pidFile }
    });
    const result = await cmdRun(
      {
        prompt: "x",
        cwd: dir,
        out: join(dir, "o.md"),
        "timeout-minutes": "0.03",
        "status-path": join(dir, "status.json")
      },
      env
    );
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "timeout");
    assert.match(result.summary, /timed out after 0.03 minutes/);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.ok(
      await waitDead(grandchild),
      "the grandchild process is still running"
    );
    assert.equal(status.status, "failed");
  });

  test("a command outside the sandbox fails instead of waiting for approval", async () => {
    // codex exec has no approval prompt and approval_policy="never" makes a
    // sandbox escape fail: the run ends with Codex's answer, it never blocks.
    const env = scenario({
      exec: {
        events: [
          {
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "rm -rf /outside",
              exit_code: 1,
              status: "failed",
              aggregated_output: "blocked by sandbox"
            }
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Could not write outside the workspace"
            }
          },
          USAGE_EVENT
        ],
        last_message: "Could not write outside the workspace"
      }
    });
    const result = await cmdRun(
      {
        prompt: "x",
        cwd: dir,
        out: join(dir, "o.md"),
        "timeout-minutes": "0.5"
      },
      env
    );
    assert.equal(result.status, "done");
    assert.match(result.summary, /Could not write outside/);
    assert.ok(calls()[0].argv.includes(APPROVAL_OVERRIDE));
    assert.ok(result.duration_seconds < 30);
  });

  test("an output schema parses the last message as JSON", async () => {
    const schema = join(dir, "schema.json");
    writeFileSync(schema, JSON.stringify({ type: "object" }));
    let env = scenario({ exec: { last_message: '{"files":["a.js"]}' } });
    const ok = await cmdRun(
      {
        prompt: "x",
        cwd: dir,
        out: join(dir, "o.md"),
        "output-schema": schema
      },
      env
    );
    assert.equal(ok.status, "done");
    assert.deepEqual(ok.result, { files: ["a.js"] });
    const argv = calls()[0].argv;
    assert.equal(argv[argv.indexOf("--output-schema") + 1], schema);
    env = scenario({ exec: { last_message: "not json" } });
    const bad = await cmdRun(
      {
        prompt: "x",
        cwd: dir,
        out: join(dir, "o2.md"),
        "output-schema": schema
      },
      env
    );
    assert.equal(bad.status, "failed");
    assert.equal(bad.reason, "invalid-output");
  });

  test("usage errors exit 2 from the CLI", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "run", "--cwd", dir], {
      encoding: "utf8"
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--prompt/);
    const bad = spawnSync(
      process.execPath,
      [SCRIPT, "run", "--prompt", "x", "--sandbox", "danger-full-access"],
      { encoding: "utf8" }
    );
    assert.equal(bad.status, 2);
  });

  test("the CLI exits 1 on a failed run and prints the JSON", () => {
    const env = scenario({
      exec: { exit_code: 1, stderr: "boom", last_message: null }
    });
    const res = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "run",
        "--prompt",
        "x",
        "--cwd",
        dir,
        "--out",
        join(dir, "o.md")
      ],
      { encoding: "utf8", env }
    );
    assert.equal(res.status, 1);
    assert.equal(JSON.parse(res.stdout).status, "failed");
  });

  test("with --run-dir it logs one decision and a notes line", async () => {
    const runDir = makeRunDir();
    const env = scenario({ exec: { last_message: "Listed 3 files" } });
    const result = await cmdRun(
      { prompt: "x", cwd: dir, "run-dir": runDir },
      env
    );
    assert.equal(result.status, "done");
    assert.equal(result.out, join(runDir, "codex", "run-1.md"));
    assert.equal(result.decision, "D001");
    const decisions = readFileSync(join(runDir, "decisions.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(decisions.length, 1);
    assert.equal(JSON.parse(decisions[0]).phase, "codex");
    assert.match(
      readFileSync(join(runDir, "notes.md"), "utf8"),
      /Codex done: Listed 3 files/
    );
  });
});

describe("detach and wait", () => {
  test("detach returns at once and wait reports running, then the result", async () => {
    const env = scenario({
      exec: { delay_ms: 2500, last_message: "Finished" }
    });
    const out = join(dir, "o.md");
    const res = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "run",
        "--prompt",
        "long task",
        "--cwd",
        dir,
        "--out",
        out,
        "--detach"
      ],
      { encoding: "utf8", env }
    );
    assert.equal(res.status, 0, res.stderr);
    const started = JSON.parse(res.stdout);
    assert.equal(started.status, "running");
    assert.ok(started.pid > 0);
    assert.equal(started.out, out);
    assert.equal(started.status_path, `${out}.status.json`);

    const before = Date.now();
    const pending = await cmdWait({
      "status-path": started.status_path,
      "max-minutes": "0.005",
      "interval-seconds": "0.1"
    });
    assert.equal(pending.status, "running");
    assert.ok(Date.now() - before < 5000);

    const final = await cmdWait({
      "status-path": started.status_path,
      "max-minutes": "1",
      "interval-seconds": "0.1"
    });
    assert.equal(final.status, "done");
    assert.equal(final.summary, "Finished");
    assert.equal(calls()[0].stdin, "long task");
  });

  test("wait reports a runner that died without a result", async () => {
    const statusPath = join(dir, "status.json");
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    writeFileSync(
      statusPath,
      JSON.stringify({ status: "running", pid: dead, out: "o" })
    );
    const result = await cmdWait({
      "status-path": statusPath,
      "interval-seconds": "0.1"
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "exited");
  });

  test("wait needs a status file", async () => {
    await assert.rejects(
      () => cmdWait({}),
      (err) => err.exitCode === 2
    );
    await assert.rejects(
      () => cmdWait({ "status-path": join(dir, "missing.json") }),
      /Status file not found/
    );
  });
});

describe("review", () => {
  let repo;

  beforeEach(() => {
    repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.js"), "export const a = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
  });

  const FINDINGS = {
    summary: "One bug",
    findings: [
      {
        severity: "high",
        dimension: "correctness",
        class: "A",
        file: "a.js",
        line: 1,
        title: "Wrong constant",
        evidence: "a is 2, callers expect 1",
        fix: "Set a back to 1",
        options: null,
        recommended: null
      }
    ]
  };

  test("reviews local changes read-only with the finding schema", async () => {
    writeFileSync(join(repo, "a.js"), "export const a = 2;\n");
    const env = scenario({ exec: { last_message: JSON.stringify(FINDINGS) } });
    const out = join(dir, "review.md");
    const result = await cmdReview("", { cwd: repo, out }, env);
    assert.equal(result.status, "done");
    assert.equal(result.summary, "One bug");
    assert.equal(result.target.kind, "local");
    assert.deepEqual(result.findings, normalizeFindings(FINDINGS));
    assert.equal(result.findings[0].source, "codex");
    assert.equal(result.findings[0].location, "a.js:1");
    const [call] = calls();
    assert.equal(call.argv[call.argv.indexOf("-s") + 1], "read-only");
    const schemaPath = call.argv[call.argv.indexOf("--output-schema") + 1];
    assert.deepEqual(
      JSON.parse(readFileSync(schemaPath, "utf8")),
      reviewSchema()
    );
    assert.ok(call.argv.includes(APPROVAL_OVERRIDE));
    assert.ok(!call.argv.includes("review"), "never uses codex exec review");
    assert.match(call.stdin, /the uncommitted changes/);
    assert.ok(call.stdin.includes(result.diff));
    assert.match(readFileSync(result.diff, "utf8"), /export const a = 2/);
  });

  test("a branch is reviewed against its base", async () => {
    git(repo, "checkout", "-q", "-b", "feature/b");
    writeFileSync(join(repo, "b.js"), "export const b = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "add b");
    const env = scenario({
      exec: { last_message: '{"summary":"Clean","findings":[]}' }
    });
    const result = await cmdReview(
      "",
      { cwd: repo, out: join(dir, "r.md") },
      env
    );
    assert.equal(result.target.kind, "branch");
    assert.equal(result.target.base, git(repo, "rev-parse", "main"));
    assert.equal(result.target.head, git(repo, "rev-parse", "HEAD"));
    assert.deepEqual(result.findings, []);
    assert.match(calls()[0].stdin, /the current branch against main/);
  });

  test("a pull request maps to its base and head through gh", async () => {
    const fakeGh = join(dir, "fake-gh.mjs");
    writeFileSync(
      fakeGh,
      `const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ number: 7, title: "T", url: "https://github.com/o/r/pull/7", baseRefName: "main", headRefName: "feature/x", headRefOid: "${"c".repeat(40)}" }));
} else if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write("diff --git a/x.js b/x.js\\n+++ b/x.js\\n+export const x = 1;\\n");
} else process.exit(3);
`
    );
    const env = {
      ...scenario({
        exec: { last_message: '{"summary":"Clean","findings":[]}' }
      }),
      ESP_GH_CMD: JSON.stringify([process.execPath, fakeGh])
    };
    const result = await cmdReview(
      "#7",
      { cwd: repo, out: join(dir, "r.md") },
      env
    );
    assert.equal(result.target.kind, "pr");
    assert.equal(result.target.base, "main");
    assert.equal(result.target.head, "c".repeat(40));
    const prompt = calls()[0].stdin;
    assert.match(prompt, /pull request #7 \(main <- feature\/x\)/);
    assert.match(prompt, new RegExp(`main\\.\\.${"c".repeat(40)}`));
  });

  test("an empty diff skips Codex", async () => {
    const env = scenario({ exec: { last_message: "unused" } });
    git(repo, "checkout", "-q", "-b", "feature/empty");
    const result = await cmdReview(
      "",
      { cwd: repo, out: join(dir, "r.md") },
      env
    );
    assert.equal(result.status, "done");
    assert.deepEqual(result.findings, []);
    assert.deepEqual(calls(), []);
  });

  test("review refuses a writable sandbox", async () => {
    await assert.rejects(
      () =>
        cmdReview("", { cwd: repo, sandbox: "workspace-write" }, process.env),
      (err) => err.exitCode === 2
    );
  });
});

describe("doctor", () => {
  test("ok when installed, logged in and the smoke prompt answers", async () => {
    const env = scenario({ exec: { last_message: "ok" } });
    const result = await cmdDoctor({}, env);
    assert.equal(result.status, "ok");
    assert.equal(result.summary, "Codex 0.128.0 is ready");
    assert.deepEqual(
      result.checks.map((c) => c.name),
      ["version", "login", "smoke"]
    );
    assert.ok(calls()[0].argv.includes("--skip-git-repo-check"));
  });

  test("a broken login is one line with the fix", async () => {
    const env = scenario({ login: { code: 1, message: "Not logged in" } });
    const result = await cmdDoctor({}, env);
    assert.equal(result.status, "failed");
    assert.equal(
      result.summary,
      "login failed: Not logged in. Fix: run `codex login`"
    );
    assert.ok(!result.summary.includes("\n"));
    assert.deepEqual(calls(), []);
  });

  test("a model failure in the smoke prompt names the fix", async () => {
    const env = scenario({
      exec: {
        events: [{ type: "turn.failed", error: { message: MODEL_ERROR } }],
        last_message: null,
        exit_code: 1
      }
    });
    const result = await cmdDoctor({}, env);
    assert.equal(result.status, "failed");
    assert.match(
      result.summary,
      /^smoke failed: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account\. Fix: pass --model/
    );
  });

  test("an old or missing Codex fails the version check", async () => {
    let result = await cmdDoctor(
      {},
      scenario({ version: "codex-cli 0.100.0" })
    );
    assert.equal(result.status, "failed");
    assert.match(
      result.summary,
      /^version failed: Codex 0.100.0 is older than 0.128.0/
    );
    result = await cmdDoctor({}, scenario({ version: null }));
    assert.match(result.summary, /^install failed: .*npm i -g @openai\/codex/);
  });

  test("--no-smoke skips the prompt", async () => {
    const result = await cmdDoctor({ "no-smoke": true }, scenario({}));
    assert.equal(result.status, "ok");
    assert.deepEqual(calls(), []);
  });
});
