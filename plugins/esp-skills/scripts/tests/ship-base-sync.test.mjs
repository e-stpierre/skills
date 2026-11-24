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

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "ship.mjs");
const RUNS = join(HERE, "..", "runs.mjs");
const NOW = "2026-11-08T12:00:00.000Z";
const PR = "https://github.com/o/r/pull/7";

let tmp;
let home;
let origin;
let repo;
let other;
let runDir;
let upstreamCommits = 0;

function cli(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ESP_SKILLS_HOME: home, ESP_RUNS_NOW: NOW }
  });
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json: () => JSON.parse(r.stdout)
  };
}

const ship = (...args) => cli(SCRIPT, [...args, "--run-dir", runDir]);
const state = () => JSON.parse(readFileSync(join(runDir, "ship.json"), "utf8"));
const jsonl = (name) =>
  existsSync(join(runDir, name))
    ? readFileSync(join(runDir, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function gitIn(cwd, ...args) {
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
    { cwd, encoding: "utf8" }
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const git = (...args) => gitIn(repo, ...args);

function commitIn(cwd, file, text, message) {
  writeFileSync(join(cwd, file), text);
  gitIn(cwd, "add", file);
  gitIn(cwd, "commit", "-qm", message);
  return gitIn(cwd, "rev-parse", "HEAD");
}

/** Another clone pushes a new commit to origin/main. */
function moveOriginMain() {
  if (!existsSync(other)) gitIn(tmp, "clone", "-q", origin, other);
  else gitIn(other, "pull", "-q", "origin", "main");
  commitIn(other, "upstream.txt", `${Date.now()}\n`, "upstream change");
  gitIn(other, "push", "-q", "origin", "main");
  return gitIn(other, "rev-parse", "HEAD");
}

function writeUserConfig(extra = {}) {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      version: 1,
      worktrees: { root: join(tmp, "worktrees") },
      ...extra
    })
  );
}

function init(...extra) {
  const r = ship(
    "init",
    "--request",
    "Add OAuth login",
    "--track",
    "inline",
    "--base",
    "main",
    "--project-dir",
    repo,
    ...extra
  );
  assert.equal(r.code, 0, r.stderr);
  return r.json();
}

function baseSync(...args) {
  const r = ship("base-sync", ...args);
  assert.equal(r.code, 0, r.stderr);
  return r.json();
}

/** Init a run and put the task on a branch with one commit. */
function startTask() {
  init();
  const ws = ship("workspace", "--branch", "feature/oauth");
  assert.equal(ws.code, 0, ws.stderr);
  commitIn(repo, "b.txt", "b\n", "task change");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "esp-ship-sync-"));
  home = join(tmp, "home");
  origin = join(tmp, "origin.git");
  repo = join(tmp, "repo");
  other = join(tmp, "other");
  mkdirSync(home);
  mkdirSync(repo);
  writeUserConfig();
  gitIn(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git("init", "-q", "-b", "main");
  commitIn(repo, "a.txt", "a\n", "init");
  git("remote", "add", "origin", origin);
  git("push", "-q", "-u", "origin", "main");
  const created = cli(RUNS, [
    "create",
    "oauth",
    "--root",
    join(tmp, "runs"),
    "--workflow",
    "esp-ship",
    "--project-dir",
    repo
  ]);
  assert.equal(created.code, 0, created.stderr);
  runDir = created.json().run_dir;
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("base-sync check", () => {
  test("an up-to-date branch needs no rebase", () => {
    startTask();
    const out = baseSync();
    assert.equal(out.action, "none");
    assert.equal(out.base, "main");
    assert.equal(out.behind, 0);
    assert.equal(out.onto, git("rev-parse", "origin/main"));
  });

  test("a new commit on origin/main asks for a rebase", () => {
    startTask();
    const upstream = moveOriginMain();
    const out = baseSync();
    assert.equal(out.action, "rebase");
    assert.equal(out.behind, 1);
    assert.equal(out.onto, upstream);
    assert.equal(out.branch_base, state().base_sha);
    // The check alone records nothing.
    assert.equal(state().base_sync, undefined);
  });

  test("an adopted pull request returns none with a reason", () => {
    const r = ship("init", "--pr", PR, "--base", "main", "--project-dir", repo);
    assert.equal(r.code, 0, r.stderr);
    moveOriginMain();
    const out = baseSync();
    assert.equal(out.action, "none");
    assert.match(out.reason, /adopted pull request/);
  });
});

describe("base-sync --record", () => {
  test("rebased updates base_sha to the new base", () => {
    startTask();
    const before = state().base_sha;
    const upstream = moveOriginMain();
    git("fetch", "-q", "origin", "main");
    git("rebase", "-q", "origin/main");
    const out = baseSync("--record", "--result", "rebased");
    assert.equal(out.action, "recorded");
    assert.equal(out.base_sha, upstream);
    const s = state();
    assert.notEqual(s.base_sha, before);
    assert.equal(s.base_sha, upstream);
    assert.equal(s.base_sync.last.result, "rebased");
    assert.equal(s.base_sync.last.at, NOW);
    assert.equal(baseSync().action, "none");

    const pass = baseSync("--record", "--result", "pass");
    assert.equal(pass.action, "recorded");
    assert.deepEqual(
      state().base_sync.history.map((h) => h.result),
      ["rebased", "pass"]
    );
    assert.equal(state().stop ?? null, null);
  });

  test("conflict stops awaiting-human", () => {
    startTask();
    const out = baseSync(
      "--record",
      "--result",
      "conflict",
      "--reason",
      "b.txt conflicts"
    );
    assert.equal(out.action, "stop");
    const s = state();
    assert.equal(s.stop.status, "awaiting-human");
    assert.match(s.stop.reason, /b\.txt conflicts/);
    assert.equal(s.base_sync.last.result, "conflict");
  });

  test("fail halts with gates-exhausted", () => {
    startTask();
    const out = baseSync(
      "--record",
      "--result",
      "fail",
      "--reason",
      "test fails"
    );
    assert.equal(out.action, "halt");
    const s = state();
    assert.equal(s.halt.key, "gates-exhausted");
    assert.match(s.halt.reason, /test fails/);
    assert.equal(s.stop ?? null, null);
    const halt = jsonl("decisions.jsonl").find(
      (d) => d.decision === "Halt the task (gates-exhausted)"
    );
    assert.ok(halt);
    assert.equal(halt.phase, "base-sync");
  });

  test("fail stops failed when gates-exhausted is not in halt_on", () => {
    writeUserConfig({ ship: { halt_on: ["budget"] } });
    startTask();
    const out = baseSync(
      "--record",
      "--result",
      "fail",
      "--reason",
      "test fails"
    );
    assert.equal(out.action, "stop");
    const s = state();
    assert.equal(s.stop.status, "failed");
    assert.equal(s.halt ?? null, null);
  });

  test("usage errors exit 2", () => {
    startTask();
    assert.equal(ship("base-sync", "--record").code, 2);
    assert.equal(ship("base-sync", "--record", "--result", "merged").code, 2);
    assert.equal(ship("base-sync", "--record", "--result", "conflict").code, 2);
    assert.equal(ship("base-sync", "--record", "--result", "fail").code, 2);
  });
});
