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
  WaitForError,
  findPr,
  outputTail,
  run,
  waitSettings
} from "../wait-for.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "wait-for.mjs");
const NOW = "2026-11-24T12:00:00.000Z";

let tmp;
let home;
let statePath;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "esp-wait-for-"));
  home = join(tmp, "home");
  mkdirSync(home);
  statePath = join(tmp, "run", "waits", "check.json");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const env = () => ({ ESP_SKILLS_HOME: home });
const state = () => JSON.parse(readFileSync(statePath, "utf8"));

// A clock that each sleep moves forward by the slept time.
function clock(start = NOW) {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    advance: (ms) => {
      at += ms;
    }
  };
}

/** An `exec` that fails until its `succeedAt`-th call, then exits 0. */
function fakeExec(succeedAt = Infinity) {
  const calls = [];
  const exec = (cmd, opts) => {
    calls.push({ cmd, ...opts });
    return calls.length >= succeedAt
      ? { status: 0, stdout: "released 1.2.0\n", stderr: "", error: null }
      : { status: 1, stdout: "", stderr: "not yet\n", error: null };
  };
  exec.calls = calls;
  return exec;
}

function io(time, extra = {}, onSleep = () => {}) {
  const logs = [];
  const sleeps = [];
  return {
    now: time.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      time.advance(ms);
      onSleep(sleeps.length);
    },
    log: (line) => logs.push(line),
    logs,
    sleeps,
    ...extra
  };
}

async function waitCommand(time, extra, args = [], onSleep) {
  const res = await run(
    ["command", "--run", "npm view pkg@1.2.0", "--state", statePath, ...args],
    env(),
    io(time, extra, onSleep)
  );
  return { ...res, block: JSON.parse(res.output) };
}

describe("command wait loop", () => {
  test("succeeds after N polls with the output tail", async () => {
    const exec = fakeExec(3);
    const { block, exitCode } = await waitCommand(clock(), { exec }, [
      "--interval-seconds",
      "10"
    ]);
    assert.equal(exitCode, 0);
    assert.equal(block.status, "done");
    assert.equal(block.outputs.kind, "command");
    assert.equal(block.outputs.target, "npm view pkg@1.2.0");
    assert.equal(block.outputs.polls, 3);
    assert.equal(block.outputs.exit_code, 0);
    assert.match(block.outputs.output_tail, /released 1\.2\.0/);
    assert.equal(block.outputs.deadline, "2026-11-24T13:00:00.000Z");
    assert.equal(exec.calls.length, 3);
    const saved = state();
    assert.equal(saved.wait_format, 1);
    assert.equal(saved.status, "done");
    assert.equal(saved.polls, 3);
    assert.equal(saved.last_exit, 0);
    assert.equal(saved.ended_at, "2026-11-24T12:00:20.000Z");
  });

  test("reaching the deadline gives awaiting-human and exit 0", async () => {
    const time = clock();
    const tools = { exec: fakeExec() };
    const { block, exitCode } = await waitCommand(time, tools, [
      "--timeout-minutes",
      "2",
      "--interval-seconds",
      "30"
    ]);
    assert.equal(exitCode, 0);
    assert.equal(block.status, "awaiting-human");
    assert.equal(block.outputs.timed_out, true);
    assert.equal(block.outputs.polls, 5);
    assert.equal(block.outputs.exit_code, 1);
    assert.match(block.blockers[0], /a rerun starts a new deadline/);
    assert.equal(time.now().toISOString(), "2026-11-24T12:02:00.000Z");
    assert.equal(state().last_exit, 1);
    assert.equal(state().ended_at, "2026-11-24T12:02:00.000Z");
  });

  test("a rerun after an interrupted wait keeps the first deadline", async () => {
    const time = clock();
    // The shell kills the first wait during its first sleep.
    await assert.rejects(
      waitCommand(
        time,
        { exec: fakeExec() },
        ["--timeout-minutes", "2"],
        () => {
          throw new Error("killed");
        }
      ),
      /killed/
    );
    assert.equal(state().ended_at, null);
    assert.equal(state().deadline, "2026-11-24T12:02:00.000Z");

    // A rerun with a longer timeout still ends at the first deadline.
    const { block } = await waitCommand(time, { exec: fakeExec() }, [
      "--timeout-minutes",
      "60"
    ]);
    assert.equal(block.status, "awaiting-human");
    assert.equal(block.outputs.deadline, "2026-11-24T12:02:00.000Z");
    assert.equal(time.now().toISOString(), "2026-11-24T12:02:00.000Z");
    assert.equal(state().started_at, NOW);
    assert.equal(state().resumed_at, "2026-11-24T12:00:30.000Z");
    assert.equal(block.outputs.polls, 5);
  });

  test("a rerun after an ended wait starts a new deadline", async () => {
    const time = clock();
    const first = await waitCommand(time, { exec: fakeExec() }, [
      "--timeout-minutes",
      "2"
    ]);
    assert.equal(first.block.outputs.deadline, "2026-11-24T12:02:00.000Z");

    const rerun = await waitCommand(time, { exec: fakeExec(2) }, [
      "--timeout-minutes",
      "3"
    ]);
    assert.equal(rerun.block.status, "done");
    assert.equal(rerun.block.outputs.deadline, "2026-11-24T12:05:00.000Z");
    assert.equal(rerun.block.outputs.polls, 2);
    assert.equal(state().started_at, "2026-11-24T12:02:00.000Z");
    assert.equal(state().resumed_at, null);
  });

  test("another target starts a new deadline even when the wait is open", async () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        wait_format: 1,
        kind: "command",
        target: "something else",
        started_at: "2026-11-24T11:00:00.000Z",
        deadline: "2026-11-24T11:01:00.000Z",
        ended_at: null,
        polls: 4,
        status: "waiting"
      })
    );
    const { block } = await waitCommand(clock(), { exec: fakeExec(1) });
    assert.equal(block.status, "done");
    assert.equal(block.outputs.deadline, "2026-11-24T13:00:00.000Z");
    assert.equal(block.outputs.polls, 1);
  });

  test("a command that cannot start fails with exit 1", async () => {
    const exec = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: "spawn ENOENT"
    });
    const { block, exitCode } = await waitCommand(clock(), { exec });
    assert.equal(exitCode, 1);
    assert.equal(block.status, "failed");
    assert.match(block.summary, /could not start: spawn ENOENT/);
    assert.equal(state().status, "failed");
  });

  test("the timeout and interval come from the run snapshot", async () => {
    const runDir = join(tmp, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "config.snapshot.json"),
      JSON.stringify({
        orchestrate: { wait: { timeout_minutes: 1, interval_seconds: 20 } }
      })
    );
    const time = clock();
    const tools = io(time, { exec: fakeExec() });
    const res = await run(
      ["command", "--run", "true", "--run-dir", runDir],
      env(),
      tools
    );
    const block = JSON.parse(res.output);
    assert.equal(block.status, "awaiting-human");
    assert.equal(block.outputs.deadline, "2026-11-24T12:01:00.000Z");
    assert.deepEqual(tools.sleeps, [20000, 20000, 20000]);
    assert.equal(existsSync(statePath), false);
  });

  test("defaults to 60 minutes and 30 seconds", () => {
    assert.deepEqual(waitSettings({}, {}), {
      timeoutMinutes: 60,
      intervalSeconds: 30
    });
    assert.deepEqual(
      waitSettings(
        { "timeout-minutes": "5", "interval-seconds": "2" },
        { timeout_minutes: 90 }
      ),
      { timeoutMinutes: 5, intervalSeconds: 2 }
    );
  });

  test("the output tail keeps the last 2000 characters", () => {
    const tail = outputTail("a".repeat(3000), "end");
    assert.equal(tail.length, 2000);
    assert.ok(tail.endsWith("\nend"));
  });
});

describe("pull request matching", () => {
  const LIST = [
    {
      number: 12,
      url: "https://github.com/o/r/pull/12",
      headRefName: "changeset-release/main",
      baseRefName: "main",
      title: "Version Packages",
      state: "CLOSED",
      author: { login: "app/github-actions" }
    },
    {
      number: 14,
      url: "https://github.com/o/r/pull/14",
      headRefName: "changeset-release/main",
      baseRefName: "main",
      title: "Version Packages",
      state: "OPEN",
      author: { login: "app/github-actions" }
    },
    {
      number: 15,
      url: "https://github.com/o/r/pull/15",
      headRefName: "feature/x",
      baseRefName: "develop",
      title: "Add x",
      state: "OPEN",
      author: { login: "someone" }
    }
  ];

  test("prefers an open pull request, then the newest", () => {
    assert.equal(findPr(LIST, { head: "changeset-release/main" }).number, 14);
    assert.equal(findPr(LIST, { author: "App/GitHub-Actions" }).number, 14);
    assert.equal(findPr(LIST, { author: "someone", base: "main" }), null);
    assert.equal(
      findPr(LIST, { author: "someone", title: "^Add " }).number,
      15
    );
    assert.equal(findPr(LIST, { head: "feature/x", title: "^Version" }), null);
  });
});

describe("CLI", () => {
  let fakeGh;
  let listFile;
  let countFile;

  beforeEach(() => {
    fakeGh = join(tmp, "fake-gh.mjs");
    listFile = join(tmp, "prs.json");
    countFile = join(tmp, "gh-calls.log");
    writeFileSync(
      fakeGh,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(countFile)}, args.join(" ") + "\\n");
if (args[0] !== "pr" || args[1] !== "list") process.exit(3);
const file = ${JSON.stringify(listFile)};
if (!existsSync(file)) { console.error("HTTP 502"); process.exit(1); }
console.log(readFileSync(file, "utf8"));
`
    );
  });

  function cli(...args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ESP_SKILLS_HOME: home,
        ESP_RUNS_NOW: NOW,
        ESP_GH_CMD: JSON.stringify([process.execPath, fakeGh])
      }
    });
    const lines = r.stdout.trim().split("\n");
    return {
      code: r.status,
      stderr: r.stderr,
      json: () => JSON.parse(lines[lines.length - 1])
    };
  }

  const prList = () =>
    writeFileSync(
      listFile,
      JSON.stringify([
        {
          number: 21,
          url: "https://github.com/o/r/pull/21",
          headRefName: "changeset-release/main",
          baseRefName: "main",
          title: "Version Packages",
          state: "OPEN",
          author: { login: "app/github-actions" }
        }
      ])
    );

  test("command --once with a command that exits 0 is done", () => {
    const r = cli(
      "command",
      "--run",
      `"${process.execPath}" -e "console.log('ok'); process.exit(0)"`,
      "--once",
      "--state",
      statePath
    );
    assert.equal(r.code, 0, r.stderr);
    const block = r.json();
    assert.equal(block.status, "done");
    assert.equal(block.outputs.exit_code, 0);
    assert.match(block.outputs.output_tail, /ok/);
    assert.equal(state().status, "done");
  });

  test("command --once with a failing command is waiting, with its deadline kept", () => {
    const cmd = `"${process.execPath}" -e "process.exit(4)"`;
    const first = cli("command", "--run", cmd, "--once", "--state", statePath);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json().status, "waiting");
    assert.equal(first.json().outputs.exit_code, 4);
    assert.equal(state().ended_at, null);
    const second = cli("command", "--run", cmd, "--once", "--state", statePath);
    assert.equal(second.json().outputs.polls, 2);
    assert.equal(second.json().outputs.deadline, "2026-11-24T13:00:00.000Z");
    assert.equal(state().last_exit, 4);
  });

  test("a command in a missing directory fails with exit 1", () => {
    const r = cli(
      "command",
      "--run",
      "echo hi",
      "--cwd",
      join(tmp, "missing"),
      "--once"
    );
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.json().status, "failed");
  });

  test("pr matches by head and returns its number, URL and head", () => {
    prList();
    const r = cli(
      "pr",
      "--repo",
      "o/r",
      "--head",
      "changeset-release/main",
      "--base",
      "main",
      "--title",
      "^Version",
      "--once"
    );
    assert.equal(r.code, 0, r.stderr);
    const block = r.json();
    assert.equal(block.status, "done");
    assert.equal(block.outputs.pr.number, 21);
    assert.equal(block.outputs.pr.url, "https://github.com/o/r/pull/21");
    assert.equal(block.outputs.pr.head, "changeset-release/main");
    assert.match(
      readFileSync(countFile, "utf8"),
      /pr list --repo o\/r --state all --limit 50 --json number,url,headRefName,author,title,baseRefName,state/
    );
  });

  test("pr matches by author", () => {
    prList();
    const r = cli(
      "pr",
      "--repo",
      "o/r",
      "--author",
      "app/github-actions",
      "--once"
    );
    assert.equal(r.json().status, "done");
    assert.equal(r.json().outputs.pr.number, 21);
  });

  test("pr with no match is waiting", () => {
    prList();
    const r = cli("pr", "--repo", "o/r", "--head", "other", "--once");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().status, "waiting");
    assert.equal(r.json().outputs.pr, undefined);
  });

  test("three gh errors in a row are tolerated, the fourth fails", () => {
    const args = [
      "pr",
      "--repo",
      "o/r",
      "--head",
      "x",
      "--once",
      "--state",
      statePath
    ];
    for (let i = 1; i <= 3; i++) {
      const r = cli(...args);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json().status, "waiting");
      assert.equal(state().errors, i);
    }
    const last = cli(...args);
    assert.equal(last.code, 1);
    assert.equal(last.json().status, "failed");
    assert.match(last.json().summary, /HTTP 502/);
  });

  test("a successful gh call resets the error count", async () => {
    let calls = 0;
    const client = {
      list() {
        calls += 1;
        if (calls <= 3) throw new WaitForError("HTTP 502");
        if (calls === 4) return [];
        if (calls <= 7) throw new WaitForError("HTTP 502");
        return [
          {
            number: 3,
            url: "https://github.com/o/r/pull/3",
            headRefName: "x",
            state: "OPEN"
          }
        ];
      }
    };
    const res = await run(
      ["pr", "--repo", "o/r", "--head", "x"],
      env(),
      io(clock(), { client })
    );
    const block = JSON.parse(res.output);
    assert.equal(block.status, "done");
    assert.equal(block.outputs.polls, 8);
  });

  test("usage errors exit 2", () => {
    for (const args of [
      [],
      ["nope"],
      ["command"],
      ["command", "--run", "x", "--head", "y"],
      ["pr", "--repo", "o/r"],
      ["pr", "--repo", "bad", "--head", "x"],
      ["pr", "--repo", "o/r", "--head", "x", "--title", "("],
      ["command", "--run", "x", "--timeout-minutes", "-1"],
      ["command", "--run", "x", "--run-dir", join(tmp, "missing")]
    ]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        env: { ...process.env, ESP_SKILLS_HOME: home }
      });
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    }
  });
});
