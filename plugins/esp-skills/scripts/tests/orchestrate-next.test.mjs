import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
import { quoteArg, resolveMode, runStatus } from "../lib/orchestrate/next.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "orchestrate.mjs");
const RUNS = join(HERE, "..", "runs.mjs");
const WAIT_FOR = join(HERE, "..", "wait-for.mjs");
const NOW = "2026-11-24T12:00:00.000Z";
const LIB_PR = "https://github.com/o/lib/pull/3";
const VERSION_PR = "https://github.com/o/lib/pull/7";
const SHA_A = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

let tmp;
let home;
let work;
let app;
let lib;
let tools;
let runDir;
let fakeGh;

function cli(script, args, extraEnv = {}) {
  const env = {
    ...process.env,
    ESP_SKILLS_HOME: home,
    ESP_RUNS_NOW: NOW,
    ESP_GH_CMD: JSON.stringify([process.execPath, fakeGh]),
    ...extraEnv
  };
  delete env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
  if (extraEnv.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH !== undefined)
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH =
      extraEnv.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env
  });
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json: () => JSON.parse(r.stdout)
  };
}

const orchestrate = (...args) => cli(SCRIPT, [...args, "--run-dir", runDir]);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const state = () => readJson(join(runDir, "orchestrate.json"));
const unitState = (id) => state().units[id];

/** Run an orchestrate command that must succeed; returns its JSON. */
function ok(...args) {
  const r = orchestrate(...args);
  assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
  return r.json();
}

/** Run an orchestrate command that must fail with `code`; returns stderr. */
function fails(code, pattern, ...args) {
  const r = orchestrate(...args);
  assert.equal(r.code, code, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, pattern);
  return r.stderr;
}

const next = (extraEnv = {}) => {
  const r = cli(SCRIPT, ["next", "--run-dir", runDir], extraEnv);
  assert.equal(r.code, 0, r.stderr);
  return r.json();
};

function gitIn(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function checkout(dir, url) {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "remote", "add", "origin", url);
}

function init(...extra) {
  return ok(
    "init",
    "--request",
    "Ship the shared presets and switch the app to them",
    "--project-dir",
    app,
    ...extra
  );
}

function intake(data) {
  const path = join(tmp, "graph-input.json");
  writeFileSync(path, JSON.stringify(data));
  return ok("intake", "--graph", path, "--record");
}

/** The ship.json esp-ship leaves in a unit run directory. */
function shipJson(id, fields) {
  const dir = join(runDir, "units", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ship.json"),
    JSON.stringify({ base: "main", worktree: null, ...fields })
  );
}

/** Run a script with the arguments of an action; returns the last stdout line as JSON. */
function runScript(script, args) {
  const r = cli(script, args);
  const lines = r.stdout.trim().split("\n");
  return { code: r.code, text: r.stdout, json: JSON.parse(lines.at(-1)) };
}

/** The example graph of the design: a library release, then its consumer. */
function exampleGraph() {
  return {
    units: [
      {
        id: "lib-presets",
        kind: "adopt",
        title: "Library presets",
        repo: "o/lib",
        pr: LIB_PR,
        settings: { merge: "human" }
      },
      {
        id: "lib-version",
        kind: "await-pr",
        title: "Version packages",
        repo: "o/lib",
        depends_on: ["lib-presets"],
        match: { head: "changeset-release/main", author: "app/github-actions" },
        settings: { checks: "none-expected" }
      },
      {
        id: "lib-published",
        kind: "check",
        title: "Release published",
        depends_on: ["lib-version"],
        command: "node -e 0",
        settings: { timeout_minutes: 30 }
      },
      {
        id: "app-presets",
        kind: "build",
        title: "App consumes the presets",
        repo: "o/app",
        depends_on: ["lib-published"],
        plan: "master",
        brief: "Switch the app to the published presets",
        settings: { branch: "feature/presets", max_rounds: 2 }
      },
      {
        id: "tasks-doc",
        kind: "build",
        title: "Tick the task document",
        repo: "o/app",
        role: "write-back",
        depends_on: ["app-presets"],
        plan: "master",
        brief: "Tick the steps of the task document",
        settings: { branch: "chore/tick-tasks" }
      }
    ]
  };
}

const build = (id, repo, fields = {}) => ({
  id,
  kind: "build",
  repo,
  brief: `Build ${id}`,
  ...fields
});
const check = (id, fields = {}) => ({
  id,
  kind: "check",
  command: "node -e 0",
  ...fields
});

/** The value following `flag` in an argument list. */
const argOf = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "esp-orchestrate-next-"));
  home = join(tmp, "home");
  work = join(tmp, "work");
  app = join(work, "app");
  lib = join(work, "lib");
  tools = join(work, "tools");
  mkdirSync(home);
  checkout(app, "https://github.com/o/app.git");
  checkout(lib, "git@github.com:o/lib.git");
  checkout(tools, "https://github.com/o/tools.git");
  fakeGh = join(tmp, "fake-gh.mjs");
  writeFileSync(
    fakeGh,
    `const args = process.argv.slice(2);
if (args[0] !== "pr" || args[1] !== "list") process.exit(3);
console.log(JSON.stringify([
  { number: 6, url: "https://github.com/o/lib/pull/6", headRefName: "feature/other", author: { login: "someone" }, title: "Other", baseRefName: "main", state: "OPEN" },
  { number: 7, url: ${JSON.stringify(VERSION_PR)}, headRefName: "changeset-release/main", author: { login: "app/github-actions" }, title: "Version Packages", baseRefName: "main", state: "OPEN" }
]));
`
  );
  const created = cli(RUNS, [
    "create",
    "presets",
    "--root",
    join(tmp, "runs"),
    "--workflow",
    "esp-orchestrate",
    "--project-dir",
    app
  ]);
  assert.equal(created.code, 0, created.stderr);
  runDir = created.json().run_dir;
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("end to end", () => {
  test("the example graph runs from intake to a merged outcome", () => {
    init("--interactive", "plan");
    assert.equal(next().action, "intake");

    // Intake and the approval checkpoint.
    intake(exampleGraph());
    const approval = next();
    assert.equal(approval.action, "checkpoint");
    assert.equal(approval.kind, "approve-plan");
    assert.equal(approval.plan_path, join(runDir, "plan.md"));
    assert.equal(approval.units.length, 5);
    fails(1, /not approved yet/, "unit", "start", "lib-presets");
    assert.equal(ok("approve").phase, "run");

    // adopt: a subagent takes over the open pull request.
    const adopt = next();
    assert.equal(adopt.action, "spawn-unit");
    assert.equal(adopt.unit, "lib-presets");
    assert.equal(adopt.mode, "subagent");
    assert.equal(adopt.resume, false);
    assert.equal(adopt.run_dir, join(runDir, "units", "lib-presets"));
    assert.deepEqual(adopt.args.slice(0, 8), [
      "--run-dir",
      join(runDir, "units", "lib-presets"),
      "--parent-run",
      runDir,
      "--project-dir",
      lib,
      "--interactive",
      "off"
    ]);
    assert.equal(argOf(adopt.args, "--pr"), LIB_PR);
    assert.equal(argOf(adopt.args, "--merge-policy"), "human");
    assert.equal(argOf(adopt.args, "--checks"), "required");
    assert.equal(argOf(adopt.args, "--max-rounds"), "3");
    assert.equal(adopt.args.includes("--plan-mode"), false);
    assert.equal(adopt.args.includes("--branch"), false);
    assert.match(adopt.invoke, /^esp-ship --run-dir /);
    const started = ok("unit", "start", "lib-presets", "--mode", "subagent");
    assert.equal(started.status, "running");
    assert.equal(unitState("lib-presets").run_dir, adopt.run_dir);
    assert.equal(unitState("lib-presets").started_at, NOW);
    assert.deepEqual(next().running, ["lib-presets"]);
    assert.equal(next().action, "idle");

    shipJson("lib-presets", { branch: "feature/presets", pr: LIB_PR });
    ok(
      "unit",
      "done",
      "lib-presets",
      "--status",
      "merged",
      "--pr",
      LIB_PR,
      "--merge-commit",
      SHA_A
    );

    // Housekeeping after the merge, before anything else starts.
    const tidyLib = next();
    assert.equal(tidyLib.action, "housekeep");
    assert.equal(tidyLib.unit, "lib-presets");
    assert.deepEqual(tidyLib.args, [
      "run",
      "--repo-dir",
      lib,
      "--base",
      "main",
      "--branch",
      "feature/presets",
      "--pr",
      LIB_PR
    ]);
    assert.match(tidyLib.script, /housekeep\.mjs$/);
    ok(
      "housekeep",
      "--unit",
      "lib-presets",
      "--result",
      JSON.stringify({ status: "done", summary: "done: 2 deleted", steps: [] })
    );
    assert.equal(unitState("lib-presets").housekept, true);

    // await-pr: wait for the version pull request, then adopt it.
    const versionWait = next();
    assert.equal(versionWait.action, "start-wait");
    assert.equal(versionWait.unit, "lib-version");
    assert.equal(versionWait.wait, "pr");
    assert.deepEqual(versionWait.args, [
      "pr",
      "--repo",
      "o/lib",
      "--head",
      "changeset-release/main",
      "--author",
      "app/github-actions",
      "--state",
      join(runDir, "waits", "lib-version.json"),
      "--run-dir",
      runDir
    ]);
    const waitStarted = ok("wait", "start", "lib-version");
    assert.equal(waitStarted.status, "waiting");
    assert.deepEqual(waitStarted.args, versionWait.args);
    assert.equal(state().waits["lib-version"].status, "started");
    assert.deepEqual(next().waiting, ["lib-version"]);

    const found = runScript(WAIT_FOR, versionWait.args);
    assert.equal(found.code, 0, found.text);
    assert.equal(found.json.status, "done");
    const output = join(tmp, "lib-version.out");
    writeFileSync(output, found.text);
    const recorded = ok("wait", "record", "lib-version", "--result", output);
    assert.equal(recorded.status, "pending");
    assert.equal(recorded.pr, VERSION_PR);
    assert.equal(state().waits["lib-version"].status, "done");

    const adoptVersion = next();
    assert.equal(adoptVersion.action, "spawn-unit");
    assert.equal(adoptVersion.unit, "lib-version");
    assert.equal(argOf(adoptVersion.args, "--pr"), VERSION_PR);
    assert.equal(argOf(adoptVersion.args, "--checks"), "none-expected");
    ok("unit", "start", "lib-version");
    assert.equal(unitState("lib-version").mode, "subagent");
    shipJson("lib-version", {
      branch: "changeset-release/main",
      pr: VERSION_PR
    });
    ok("unit", "done", "lib-version", "--status", "merged");
    assert.equal(unitState("lib-version").pr, VERSION_PR);
    assert.equal(next().unit, "lib-version");
    ok(
      "housekeep",
      "--unit",
      "lib-version",
      "--result",
      JSON.stringify({ status: "done", steps: [] })
    );

    // check: poll the release, recorded from the inline JSON.
    const release = next();
    assert.equal(release.action, "start-wait");
    assert.equal(release.wait, "command");
    assert.deepEqual(release.args, [
      "command",
      "--run",
      "node -e 0",
      "--state",
      join(runDir, "waits", "lib-published.json"),
      "--run-dir",
      runDir,
      "--timeout-minutes",
      "30"
    ]);
    ok("wait", "start", "lib-published");
    const polled = runScript(WAIT_FOR, release.args);
    assert.equal(polled.json.status, "done");
    const checked = ok(
      "wait",
      "record",
      "lib-published",
      "--result",
      JSON.stringify(polled.json)
    );
    assert.equal(checked.status, "done");
    assert.equal(unitState("lib-published").ended_at, NOW);

    // build: the plan lives in the master plan, so planning is skipped.
    const appBuild = next();
    assert.equal(appBuild.action, "spawn-unit");
    assert.equal(appBuild.unit, "app-presets");
    assert.equal(appBuild.project_dir, app);
    assert.equal(argOf(appBuild.args, "--plan-mode"), "skip");
    assert.equal(argOf(appBuild.args, "--branch"), "feature/presets");
    assert.equal(argOf(appBuild.args, "--max-rounds"), "2");
    assert.equal(argOf(appBuild.args, "--merge-policy"), "auto");
    assert.equal(appBuild.args.at(-1), join(runDir, "plans", "app-presets.md"));
    ok("unit", "start", "app-presets", "--mode", "subagent");
    shipJson("app-presets", { branch: "feature/presets", pr: null });
    ok(
      "unit",
      "done",
      "app-presets",
      "--status",
      "merged",
      "--pr",
      "https://github.com/o/app/pull/12"
    );

    // Housekeeping rebases the branch of the later build of the checkout.
    const tidyApp = next();
    assert.equal(tidyApp.action, "housekeep");
    assert.deepEqual(tidyApp.rebase, ["chore/tick-tasks"]);
    assert.deepEqual(tidyApp.args.slice(-2), ["--rebase", "chore/tick-tasks"]);
    assert.equal(
      argOf(tidyApp.args, "--pr"),
      "https://github.com/o/app/pull/12"
    );
    const tidied = ok(
      "housekeep",
      "--unit",
      "app-presets",
      "--result",
      JSON.stringify({
        status: "done",
        base: "main",
        steps: [
          { step: "base", target: "main", result: "fast-forwarded" },
          { step: "branch", target: "feature/presets", result: "deleted" },
          { step: "rebase", target: "chore/tick-tasks", result: "rebased" }
        ]
      })
    );
    assert.deepEqual(tidied.rebased, [
      { unit: "tasks-doc", branch: "chore/tick-tasks", result: "rebased" }
    ]);
    assert.equal(unitState("tasks-doc").rebase.result, "rebased");
    assert.equal(unitState("tasks-doc").rebase.by, "app-presets");

    // The last unit left runs inline.
    const writeBack = next();
    assert.equal(writeBack.action, "run-unit-inline");
    assert.equal(writeBack.unit, "tasks-doc");
    assert.equal(writeBack.mode_reason, "the last unit left");
    assert.equal(argOf(writeBack.args, "--plan-mode"), "skip");
    assert.equal(argOf(writeBack.args, "--interactive"), "off");
    ok("unit", "start", "tasks-doc");
    assert.equal(unitState("tasks-doc").mode, "inline");
    shipJson("tasks-doc", { branch: "chore/tick-tasks", pr: null });
    ok("unit", "done", "tasks-doc", "--status", "merged");
    ok(
      "housekeep",
      "--unit",
      "tasks-doc",
      "--result",
      JSON.stringify({
        status: "skipped",
        reason: "dirty",
        files: [" M notes.txt"],
        steps: []
      })
    );

    // Finish and the outcome.
    const finish = next();
    assert.deepEqual(finish, {
      action: "finish",
      status: "merged",
      then: "outcome"
    });
    const outcome = ok("outcome");
    assert.equal(outcome.status, "merged");
    assert.equal(outcome.finished, true);
    assert.deepEqual(
      outcome.units.map((u) => [u.id, u.kind, u.status]),
      [
        ["lib-presets", "adopt", "merged"],
        ["lib-version", "await-pr", "merged"],
        ["lib-published", "check", "done"],
        ["app-presets", "build", "merged"],
        ["tasks-doc", "build", "merged"]
      ]
    );
    assert.equal(outcome.units[0].pr, LIB_PR);
    assert.equal(outcome.units[0].merge_commit, SHA_A);
    assert.deepEqual(outcome.dirty, [
      { unit: "tasks-doc", repo_dir: app, files: [" M notes.txt"] }
    ]);
    assert.match(outcome.resume, /^esp-orchestrate --resume --run-dir /);
    assert.equal(state().phase, "done");
  });

  test("next is read-only: the same files give the same action", () => {
    init();
    intake(exampleGraph());
    const before = readFileSync(join(runDir, "orchestrate.json"), "utf8");
    const first = orchestrate("next");
    const second = orchestrate("next");
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(
      readFileSync(join(runDir, "orchestrate.json"), "utf8"),
      before
    );
  });
});

describe("scheduling rules", () => {
  test("two ready units of one checkout run one at a time", () => {
    init("--no-housekeeping");
    intake({ units: [build("first", "o/app"), build("second", "o/app")] });
    const a = next();
    assert.equal(a.action, "spawn-unit");
    assert.equal(a.unit, "first");
    ok("unit", "start", "first");
    const waiting = next();
    assert.equal(waiting.action, "idle");
    assert.deepEqual(waiting.running, ["first"]);
    fails(1, /first is running in .*one at a time/, "unit", "start", "second");
    ok("unit", "done", "first", "--status", "merged");
    const b = next();
    assert.equal(b.unit, "second");
    assert.equal(b.action, "run-unit-inline");
  });

  test("max_parallel caps the units and waits running at once", () => {
    init("--max-parallel", "2");
    intake({
      units: [
        check("one"),
        check("two"),
        build("lib-work", "o/lib"),
        check("three")
      ]
    });
    assert.equal(next().unit, "lib-work");
    ok("unit", "start", "lib-work");
    const first = next();
    assert.equal(first.action, "start-wait");
    assert.equal(first.unit, "one");
    ok("wait", "start", "one");
    const idle = next();
    assert.equal(idle.action, "idle");
    assert.deepEqual(idle.running, ["lib-work"]);
    assert.deepEqual(idle.waiting, ["one"]);
    fails(1, /already waiting/, "wait", "start", "one");
    ok(
      "wait",
      "record",
      "one",
      "--result",
      JSON.stringify({ status: "done", outputs: { kind: "command" } })
    );
    assert.equal(next().unit, "two");
  });

  test("a failed dependency blocks its dependents while an independent unit finishes", () => {
    init("--no-housekeeping");
    intake({
      units: [
        build("lib-change", "o/lib"),
        build("app-change", "o/app", { depends_on: ["lib-change"] }),
        build("docs", "o/app", { depends_on: ["app-change"] }),
        check("tools-check", { cwd: tools })
      ]
    });
    ok("unit", "start", "lib-change");
    const failed = ok(
      "unit",
      "failed",
      "lib-change",
      "--reason",
      "Gates failed twice"
    );
    assert.deepEqual(failed.blocked, ["app-change", "docs"]);
    assert.equal(unitState("app-change").status, "blocked");
    assert.equal(unitState("docs").reason, "dependency app-change is blocked");
    fails(1, /app-change is blocked/, "unit", "start", "app-change");

    const wait = next();
    assert.equal(wait.unit, "tools-check");
    assert.equal(argOf(wait.args, "--cwd"), tools);
    ok("wait", "start", "tools-check");
    ok(
      "wait",
      "record",
      "tools-check",
      "--result",
      JSON.stringify({ status: "done", summary: "ok" })
    );
    assert.equal(next().status, "partial");
    const outcome = ok("outcome");
    assert.equal(outcome.status, "partial");
    assert.deepEqual(
      outcome.units.map((u) => [u.id, u.status, u.reason]),
      [
        ["lib-change", "failed", "Gates failed twice"],
        ["app-change", "blocked", "dependency lib-change is failed"],
        ["docs", "blocked", "dependency app-change is blocked"],
        ["tools-check", "done", null]
      ]
    );
    assert.match(outcome.summary, /1 of 4 units landed/);
  });

  test("a timed-out wait stops the unit and blocks its dependents", () => {
    init();
    intake({
      units: [
        check("release"),
        build("app", "o/app", { depends_on: ["release"] })
      ]
    });
    ok("wait", "start", "release");
    const r = ok(
      "wait",
      "record",
      "release",
      "--result",
      JSON.stringify({
        status: "awaiting-human",
        summary: "No success at the deadline",
        outputs: { kind: "command", polls: 120 }
      })
    );
    assert.equal(r.status, "awaiting-human");
    assert.deepEqual(r.blocked, ["app"]);
    assert.equal(state().waits.release.polls, 120);
    assert.equal(next().status, "awaiting-human");
  });

  test("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH below 3 gives run-unit-inline", () => {
    init("--unit-mode", "subagent");
    intake({ units: [build("a", "o/lib"), build("b", "o/app")] });
    assert.equal(next().action, "spawn-unit");
    const action = next({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" });
    assert.equal(action.action, "run-unit-inline");
    assert.match(action.mode_reason, /SPAWN_DEPTH is 1/);
    assert.equal(argOf(action.args, "--interactive"), "off");
    const r = cli(SCRIPT, ["unit", "start", "a", "--run-dir", runDir], {
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1"
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().mode, "inline");
  });

  test("-i all checkpoints before each unit and runs it inline with its checkpoints", () => {
    init("--interactive", "all");
    intake({ units: [build("a", "o/lib"), build("b", "o/app")] });
    assert.equal(next().kind, "approve-plan");
    ok("approve");
    const checkpoint = next();
    assert.equal(checkpoint.action, "checkpoint");
    assert.equal(checkpoint.kind, "before-unit");
    assert.equal(checkpoint.unit, "a");
    assert.equal(checkpoint.then.action, "run-unit-inline");
    assert.equal(argOf(checkpoint.then.args, "--interactive"), "all");
    assert.equal(checkpoint.then.args.at(-1), "Build a");
  });

  test("an unresolved repository stops at a checkpoint", () => {
    init();
    intake({ units: [build("ghost", "o/ghost")] });
    const action = next();
    assert.equal(action.action, "checkpoint");
    assert.equal(action.kind, "unresolved-repo");
    fails(1, /no checkout of o\/ghost/, "unit", "start", "ghost");
    ok("unit", "failed", "ghost", "--reason", "No checkout");
    assert.equal(next().status, "failed");
  });

  test("housekeeping with an unknown base asks for a skipped record", () => {
    init();
    intake({ units: [build("a", "o/app")] });
    ok("unit", "start", "a");
    ok("unit", "done", "a", "--status", "merged");
    const action = next();
    assert.equal(action.action, "housekeep");
    assert.equal(action.args, null);
    assert.match(action.skip, /base branch of unit a is unknown/);
    ok(
      "housekeep",
      "--unit",
      "a",
      "--result",
      JSON.stringify({ status: "skipped", reason: "no-base" })
    );
    assert.equal(next().action, "finish");
  });
});

describe("resume", () => {
  test("a run stopped before intake has nothing to resume", () => {
    init();
    const resumed = ok("resume");
    assert.equal(resumed.phase, "intake");
    assert.deepEqual(resumed.resumed, []);
    assert.match(resumed.reason, /Nothing to resume in phase intake/);
    assert.equal(next().action, "intake");
  });

  test("an interrupted unit resumes and a started wait restarts", () => {
    init();
    intake({
      units: [
        build("lib-change", "o/lib"),
        check("release"),
        build("app-change", "o/app", { depends_on: ["release"] })
      ]
    });
    ok("unit", "start", "lib-change");
    ok("wait", "start", "release");
    shipJson("lib-change", { branch: "feature/lib" });
    assert.equal(next().action, "idle");

    const resumed = ok("resume");
    assert.deepEqual(resumed.resumed, ["lib-change"]);
    assert.deepEqual(resumed.restarted, ["release"]);

    const unit = next();
    assert.equal(unit.action, "spawn-unit");
    assert.equal(unit.unit, "lib-change");
    assert.equal(unit.resume, true);
    assert.deepEqual(unit.args.slice(0, 3), [
      "--resume",
      "--run-dir",
      join(runDir, "units", "lib-change")
    ]);
    assert.equal(argOf(unit.args, "--interactive"), "off");
    const restarted = ok("unit", "start", "lib-change");
    assert.equal(restarted.resumed, true);
    assert.equal(unitState("lib-change").resume, false);

    const wait = next();
    assert.equal(wait.action, "start-wait");
    assert.equal(wait.restart, true);
    assert.equal(wait.state_file, join(runDir, "waits", "release.json"));
    const again = ok("wait", "start", "release");
    assert.equal(again.restart, true);
    assert.equal(state().waits.release.restart, false);
    assert.equal(next().action, "idle");
  });

  test("a unit stopped before esp-ship started starts over in the same run directory", () => {
    init();
    intake({ units: [build("a", "o/lib"), build("b", "o/app")] });
    ok("unit", "start", "a");
    ok("resume");
    const action = next();
    assert.equal(action.unit, "a");
    assert.equal(action.resume, false);
    assert.equal(action.args.includes("--resume"), false);
    assert.equal(action.args.at(-1), "Build a");
  });

  test("a unit awaiting a human goes again and unblocks its dependents", () => {
    init("--no-housekeeping");
    intake({
      units: [
        build("lib-change", "o/lib"),
        build("app-change", "o/app", { depends_on: ["lib-change"] })
      ]
    });
    ok("unit", "start", "lib-change");
    const stopped = ok(
      "unit",
      "blocked",
      "lib-change",
      "--reason",
      "Security finding open",
      "--question",
      "Accept the risk?"
    );
    assert.equal(stopped.status, "awaiting-human");
    assert.equal(unitState("app-change").status, "blocked");
    assert.equal(next().status, "awaiting-human");
    ok("outcome");
    assert.equal(state().phase, "done");

    const resumed = ok("resume");
    assert.deepEqual(resumed.resumed, ["lib-change"]);
    assert.deepEqual(resumed.unblocked, ["app-change"]);
    assert.equal(resumed.phase, "run");
    assert.equal(unitState("lib-change").question, null);
    shipJson("lib-change", { branch: "feature/lib" });
    assert.equal(next().resume, true);
  });

  test("resumed units of one checkout relaunch one at a time", () => {
    init("--no-housekeeping");
    intake({ units: [build("a", "o/lib"), build("b", "o/lib")] });
    ok("unit", "start", "a");
    ok("unit", "blocked", "a", "--reason", "Question", "--question", "Go?");
    ok("unit", "start", "b");
    ok("unit", "blocked", "b", "--reason", "Question", "--question", "Go?");
    shipJson("a", { branch: "feature/a" });
    shipJson("b", { branch: "feature/b" });
    assert.deepEqual(ok("resume").resumed, ["a", "b"]);

    const first = next();
    assert.equal(first.unit, "a");
    assert.equal(first.resume, true);
    ok("unit", "start", "a");
    const idle = next();
    assert.equal(idle.action, "idle");
    fails(1, /a is running in .*one at a time/, "unit", "start", "b");
    ok("unit", "done", "a", "--status", "merged");
    const second = next();
    assert.equal(second.unit, "b");
    assert.equal(second.resume, true);
    assert.equal(ok("unit", "start", "b").resumed, true);
  });

  test("resumed units relaunch within max_parallel", () => {
    init("--no-housekeeping", "--max-parallel", "1");
    intake({ units: [build("a", "o/lib"), build("b", "o/app")] });
    ok("unit", "start", "a");
    ok("unit", "blocked", "a", "--reason", "Question", "--question", "Go?");
    ok("unit", "start", "b");
    ok("unit", "blocked", "b", "--reason", "Question", "--question", "Go?");
    ok("resume");
    assert.equal(next().unit, "a");
    ok("unit", "start", "a");
    assert.equal(next().action, "idle");
    ok("unit", "done", "a", "--status", "merged");
    assert.equal(next().unit, "b");
  });
});

describe("invalid transitions", () => {
  beforeEach(() => {
    init();
    intake({
      units: [
        build("a", "o/lib"),
        check("c", { depends_on: ["a"] }),
        build("b", "o/app", { depends_on: ["c"] })
      ]
    });
  });

  test("exit 1 and change nothing", () => {
    const before = readFileSync(join(runDir, "orchestrate.json"), "utf8");
    fails(
      1,
      /a is pending: only a running unit is done/,
      "unit",
      "done",
      "a",
      "--status",
      "merged"
    );
    fails(1, /b is not ready: c is pending/, "unit", "start", "b");
    fails(1, /start its wait with "wait start c"/, "unit", "start", "c");
    fails(1, /c is not ready: a is pending/, "wait", "start", "c");
    fails(
      1,
      /a is a build unit: only check and await-pr units wait/,
      "wait",
      "start",
      "a"
    );
    fails(
      1,
      /c is pending: only a waiting unit/,
      "wait",
      "record",
      "c",
      "--result",
      '{"status":"done"}'
    );
    fails(
      1,
      /a is pending: only a merged unit is housekept/,
      "housekeep",
      "--unit",
      "a",
      "--result",
      '{"status":"done"}'
    );
    fails(1, /Unknown unit ghost/, "unit", "start", "ghost");
    assert.equal(
      readFileSync(join(runDir, "orchestrate.json"), "utf8"),
      before
    );
  });

  test("a terminal unit does not move again", () => {
    ok("unit", "start", "a");
    fails(1, /a is running/, "wait", "start", "c");
    ok("unit", "done", "a", "--status", "merged");
    fails(
      1,
      /a is merged: only a running unit is done/,
      "unit",
      "done",
      "a",
      "--status",
      "done"
    );
    fails(1, /already merged/, "unit", "failed", "a", "--reason", "x");
    fails(1, /a is merged: only a pending unit starts/, "unit", "start", "a");
    ok("housekeep", "--unit", "a", "--result", '{"status":"done","steps":[]}');
    fails(
      1,
      /already housekept/,
      "housekeep",
      "--unit",
      "a",
      "--result",
      '{"status":"done"}'
    );
    ok("wait", "start", "c");
    fails(
      1,
      /a pr wait, unit c waits with command/,
      "wait",
      "record",
      "c",
      "--result",
      '{"status":"done","outputs":{"kind":"pr"}}'
    );
  });

  test("usage errors exit 2", () => {
    fails(2, /unit needs a command/, "unit");
    fails(2, /unit needs a command/, "unit", "launch", "a");
    fails(2, /unit start needs a unit ID/, "unit", "start");
    fails(2, /--status must be one of merged, done/, "unit", "done", "a");
    fails(
      2,
      /--mode must be one of subagent, inline/,
      "unit",
      "start",
      "a",
      "--mode",
      "remote"
    );
    fails(2, /unit failed needs --reason/, "unit", "failed", "a");
    fails(
      2,
      /--status must be one of failed, halted/,
      "unit",
      "failed",
      "a",
      "--reason",
      "x",
      "--status",
      "done"
    );
    fails(2, /unit blocked needs --reason/, "unit", "blocked", "a");
    fails(
      2,
      /--merge-commit must be a commit SHA/,
      "unit",
      "done",
      "a",
      "--status",
      "merged",
      "--merge-commit",
      "main"
    );
    fails(
      2,
      /--pr must be a pull request URL/,
      "unit",
      "done",
      "a",
      "--status",
      "merged",
      "--pr",
      "#3"
    );
    fails(2, /wait needs a command/, "wait", "poll", "c");
    fails(2, /--result <json\|file> is required/, "wait", "record", "c");
    fails(
      2,
      /--result: invalid JSON/,
      "wait",
      "record",
      "c",
      "--result",
      "{status"
    );
    fails(2, /housekeep needs --unit/, "housekeep", "--result", "{}");
  });

  test("commands before intake fail", () => {
    const other = cli(RUNS, [
      "create",
      "other",
      "--root",
      join(tmp, "runs"),
      "--workflow",
      "esp-orchestrate"
    ]).json().run_dir;
    const r = cli(SCRIPT, [
      "init",
      "--request",
      "x",
      "--project-dir",
      app,
      "--run-dir",
      other
    ]);
    assert.equal(r.code, 0, r.stderr);
    const unit = cli(SCRIPT, ["unit", "start", "a", "--run-dir", other]);
    assert.equal(unit.code, 1);
    assert.match(unit.stderr, /intake --record" first/);
    const approve = cli(SCRIPT, ["approve", "--run-dir", other]);
    assert.equal(approve.code, 1);
    const outcome = cli(SCRIPT, ["outcome", "--run-dir", other]);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(outcome.json().status, "running");
  });
});

describe("helpers", () => {
  test("runStatus", () => {
    assert.equal(runStatus({ a: "merged", b: "done" }), "merged");
    assert.equal(runStatus({ a: "merged", b: "blocked" }), "partial");
    assert.equal(runStatus({ a: "halted", b: "awaiting-human" }), "halted");
    assert.equal(
      runStatus({ a: "awaiting-human", b: "blocked" }),
      "awaiting-human"
    );
    assert.equal(runStatus({ a: "failed", b: "blocked" }), "failed");
  });

  test("resolveMode", () => {
    const state = (unitMode, interactive = "off") => ({
      interactive,
      settings: { unit_mode: unitMode }
    });
    const two = { a: "pending", b: "pending" };
    assert.equal(resolveMode(state("auto"), "a", {}, two).mode, "subagent");
    assert.equal(
      resolveMode(state("auto"), "a", {}, { a: "pending", b: "merged" }).mode,
      "inline"
    );
    assert.equal(
      resolveMode(state("auto", "all"), "a", {}, two).mode,
      "inline"
    );
    assert.equal(resolveMode(state("inline"), "a", {}, two).mode, "inline");
    assert.equal(
      resolveMode(
        state("subagent"),
        "a",
        {
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2"
        },
        two
      ).mode,
      "inline"
    );
    assert.equal(
      resolveMode(
        state("auto"),
        "a",
        {
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "5"
        },
        two
      ).mode,
      "subagent"
    );
  });

  test("quoteArg", () => {
    assert.equal(quoteArg("--run-dir"), "--run-dir");
    assert.equal(quoteArg("/a/b.md"), "/a/b.md");
    assert.equal(quoteArg("node -e 0"), "'node -e 0'");
    assert.equal(quoteArg("it's"), "'it'\\''s'");
  });
});
