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
  findCycles,
  normalizeUnit,
  repoOfRemote,
  topoOrder,
  validateGraph
} from "../lib/orchestrate/graph.mjs";
import { checkState } from "../lib/orchestrate/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "orchestrate.mjs");
const RUNS = join(HERE, "..", "runs.mjs");
const NOW = "2026-11-24T12:00:00.000Z";
const LIB_PR = "https://github.com/o/lib/pull/3";

let tmp;
let home;
let work;
let app;
let lib;
let runDir;

function cli(script, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ESP_SKILLS_HOME: home,
      ESP_RUNS_NOW: NOW,
      ...extraEnv
    }
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
const graph = () => readJson(join(runDir, "graph.json"));
const jsonl = (name) =>
  existsSync(join(runDir, name))
    ? readFileSync(join(runDir, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function gitIn(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A git checkout at `dir` whose origin is `url`. */
function checkout(dir, url) {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "remote", "add", "origin", url);
}

function userConfig(config) {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ version: 1, ...config })
  );
}

function init(...extra) {
  const r = orchestrate(
    "init",
    "--request",
    "Ship the shared presets and switch the app to them",
    "--project-dir",
    app,
    ...extra
  );
  assert.equal(r.code, 0, r.stderr);
  return r.json();
}

/** adopt -> await-pr -> check -> build: a library release, then its consumer. */
function fourUnits() {
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
        repo: "o/lib",
        depends_on: ["lib-presets"],
        match: { head: "changeset-release/main", author: "app/github-actions" }
      },
      {
        id: "lib-published",
        kind: "check",
        depends_on: ["lib-version"],
        command: "node -e 0",
        settings: { timeout_minutes: 30 }
      },
      {
        id: "app-presets",
        kind: "build",
        repo: "o/app",
        depends_on: ["lib-published"],
        plan: "master",
        brief: "Switch the app to the published presets",
        settings: { branch: "feature/presets", max_rounds: 2 }
      }
    ]
  };
}

function graphFile(data, name = "graph-input.json") {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

const intake = (data, ...extra) =>
  orchestrate("intake", "--graph", graphFile(data), ...extra);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "esp-orchestrate-"));
  home = join(tmp, "home");
  work = join(tmp, "work");
  app = join(work, "app");
  lib = join(work, "lib");
  mkdirSync(home);
  checkout(app, "https://github.com/o/app.git");
  checkout(lib, "git@github.com:o/lib.git");
  mkdirSync(join(work, "notes"));
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

describe("cli", () => {
  test("--help prints every command of the contract", () => {
    const r = cli(SCRIPT, ["--help"]);
    assert.equal(r.code, 0);
    for (const command of [
      "init",
      "show",
      "intake",
      "approve",
      "next",
      "unit <cmd> <id>",
      "wait <cmd> <id>",
      "housekeep",
      "resume",
      "outcome"
    ])
      assert.match(r.stdout, new RegExp(`\\n  ${command} `));
  });

  test("no command is a usage error", () => {
    assert.equal(cli(SCRIPT, []).code, 2);
  });

  test("an unknown command exits 2", () => {
    init();
    const r = orchestrate("launch");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Unknown command: launch/);
  });

  test("--run-dir is required", () => {
    const r = cli(SCRIPT, ["init", "--request", "x"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--run-dir <path> is required/);
  });
});

describe("init", () => {
  test("writes orchestrate.json and freezes the config", () => {
    const out = init();
    assert.equal(out.created, true);
    const s = state();
    assert.equal(s.state_format, 1);
    assert.equal(s.workflow, "esp-orchestrate");
    assert.equal(
      s.request,
      "Ship the shared presets and switch the app to them"
    );
    assert.equal(s.project_dir, app);
    assert.equal(s.interactive, "off");
    assert.equal(s.phase, "intake");
    assert.equal(s.approved, false);
    assert.deepEqual(s.units, {});
    assert.deepEqual(s.waits, {});
    assert.equal(s.stop, null);
    assert.deepEqual(s.settings, {
      unit_mode: "auto",
      max_parallel: 2,
      merge_policy: "auto",
      max_rounds: 3,
      housekeeping: true,
      write_back: true,
      wait: { timeout_minutes: 60, interval_seconds: 30 }
    });
    assert.equal(s.created_at, NOW);
    const snapshot = join(runDir, "config.snapshot.json");
    assert.equal(s.config_snapshot, snapshot);
    assert.equal(readJson(snapshot).orchestrate.max_parallel, 2);
    assert.deepEqual(checkState(s), []);
  });

  test("a second call prints the state and changes nothing", () => {
    init();
    const before = readFileSync(join(runDir, "orchestrate.json"), "utf8");
    const r = cli(SCRIPT, ["init", "--request", "Other", "--run-dir", runDir], {
      ESP_RUNS_NOW: "2026-11-25T08:00:00.000Z"
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().created, false);
    assert.equal(r.json().created_at, NOW);
    assert.equal(
      readFileSync(join(runDir, "orchestrate.json"), "utf8"),
      before
    );
  });

  test("settings come from the orchestrate config section", () => {
    userConfig({
      defaults: { interactive: "plan" },
      ship: { merge_policy: "human" },
      "fix-review": { max_rounds: 5 },
      orchestrate: {
        unit_mode: "inline",
        max_parallel: 4,
        wait: { timeout_minutes: 90, interval_seconds: 10 },
        housekeeping: false,
        write_back: false
      }
    });
    const s = init();
    assert.equal(s.interactive, "plan");
    assert.deepEqual(s.settings, {
      unit_mode: "inline",
      max_parallel: 4,
      merge_policy: "human",
      max_rounds: 5,
      housekeeping: false,
      write_back: false,
      wait: { timeout_minutes: 90, interval_seconds: 10 }
    });
  });

  test("options win over the config", () => {
    userConfig({ orchestrate: { unit_mode: "inline", max_parallel: 4 } });
    const s = init(
      "--interactive",
      "all",
      "--unit-mode",
      "subagent",
      "--max-parallel",
      "1",
      "--merge-policy",
      "none",
      "--max-rounds",
      "2",
      "--no-housekeeping",
      "--no-write-back"
    );
    assert.equal(s.interactive, "all");
    assert.equal(s.settings.unit_mode, "subagent");
    assert.equal(s.settings.max_parallel, 1);
    assert.equal(s.settings.merge_policy, "none");
    assert.equal(s.settings.max_rounds, 2);
    assert.equal(s.settings.housekeeping, false);
    assert.equal(s.settings.write_back, false);
  });

  for (const [args, message] of [
    [[], /init needs --request/],
    [["--request", "x", "--unit-mode", "remote"], /--unit-mode must be one of/],
    [["--request", "x", "--interactive", "some"], /--interactive must be one/],
    [["--request", "x", "--merge-policy", "bot"], /--merge-policy must be one/],
    [
      ["--request", "x", "--max-parallel", "5"],
      /--max-parallel must be at most 4/
    ],
    [
      ["--request", "x", "--max-parallel", "0"],
      /--max-parallel must be an integer/
    ],
    [
      ["--request", "x", "--max-rounds", "two"],
      /--max-rounds must be an integer/
    ]
  ])
    test(`rejects ${args.join(" ") || "a missing request"} and writes nothing`, () => {
      const r = orchestrate("init", "--project-dir", app, ...args);
      assert.equal(r.code, 2);
      assert.match(r.stderr, message);
      assert.equal(existsSync(join(runDir, "orchestrate.json")), false);
      assert.equal(existsSync(join(runDir, "config.snapshot.json")), false);
    });

  test("show prints the state and a null graph before intake", () => {
    init();
    const r = orchestrate("show");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().phase, "intake");
    assert.equal(r.json().graph, null);
  });

  test("show before init fails", () => {
    const r = orchestrate("show");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No orchestrate.json/);
  });
});

describe("intake", () => {
  test("records a four-unit graph with every unit pending", () => {
    init();
    const r = intake(fourUnits(), "--record");
    assert.equal(r.code, 0, r.stderr);
    const out = r.json();
    assert.equal(out.recorded, true);
    assert.equal(out.phase, "run");
    assert.deepEqual(out.order, [
      "lib-presets",
      "lib-version",
      "lib-published",
      "app-presets"
    ]);
    assert.deepEqual(out.unresolved, []);

    const g = graph();
    assert.equal(g.graph_format, 1);
    assert.deepEqual(
      g.units.map((u) => [u.id, u.kind, u.repo_dir]),
      [
        ["lib-presets", "adopt", lib],
        ["lib-version", "await-pr", lib],
        ["lib-published", "check", null],
        ["app-presets", "build", app]
      ]
    );
    const build = g.units[3];
    assert.deepEqual(Object.keys(build), [
      "id",
      "kind",
      "title",
      "repo",
      "repo_dir",
      "depends_on",
      "role",
      "plan",
      "plan_path",
      "brief",
      "settings",
      "pr",
      "match",
      "command",
      "cwd"
    ]);
    assert.equal(build.title, "app-presets");
    assert.equal(build.role, "code");
    assert.equal(build.plan, "master");
    assert.equal(build.plan_path, join(runDir, "plans", "app-presets.md"));
    assert.deepEqual(build.settings, {
      merge: "auto",
      review: null,
      reviewers: [],
      max_rounds: 2,
      draft: false,
      branch: "feature/presets",
      checks: "required",
      timeout_minutes: null
    });
    assert.equal(g.units[0].settings.merge, "human");
    assert.equal(g.units[0].settings.max_rounds, 3);
    assert.equal(g.units[0].plan, null);
    assert.equal(g.units[2].settings.timeout_minutes, 30);

    const s = state();
    assert.equal(s.phase, "run");
    assert.equal(s.approved, false);
    assert.equal(s.graph_path, join(runDir, "graph.json"));
    assert.deepEqual(Object.keys(s.units), out.order);
    for (const unit of Object.values(s.units)) {
      assert.equal(unit.status, "pending");
      assert.equal(unit.housekept, false);
      assert.equal(unit.run_dir, null);
    }
    assert.equal(orchestrate("show").json().graph.units.length, 4);
  });

  test("units default to the run merge policy and max rounds", () => {
    init("--merge-policy", "none", "--max-rounds", "4");
    const r = intake(fourUnits(), "--record");
    assert.equal(r.code, 0, r.stderr);
    const [adopt, , , build] = graph().units;
    assert.equal(adopt.settings.merge, "human");
    assert.equal(build.settings.merge, "none");
    assert.equal(adopt.settings.max_rounds, 4);
  });

  test("logs one decision per sizing choice and per non-auto merge", () => {
    init();
    const data = fourUnits();
    data.units.push({
      id: "docs",
      kind: "build",
      repo: "o/app",
      depends_on: ["app-presets"],
      brief: "Tick the task document",
      role: "write-back"
    });
    const r = intake(data, "--record");
    assert.equal(r.code, 0, r.stderr);
    const decisions = jsonl("decisions.jsonl");
    assert.deepEqual(
      decisions.map((d) => [d.phase, d.refs, d.decision]),
      [
        ["intake", ["lib-presets"], "Merge policy human for unit lib-presets"],
        ["intake", ["app-presets"], "Plan unit app-presets in the master plan"],
        ["intake", ["docs"], "Let unit docs plan itself"]
      ]
    );
    assert.deepEqual(
      r.json().decisions.map((d) => d.id),
      ["D001", "D002", "D003"]
    );
    assert.equal(graph().units[4].plan, "self");
    assert.equal(graph().units[4].plan_path, null);
    assert.equal(cli(RUNS, ["check", join(runDir, "decisions.jsonl")]).code, 0);
  });

  test("-i plan moves the run to approve", () => {
    init("--interactive", "plan");
    const r = intake(fourUnits(), "--record");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().phase, "approve");
    assert.equal(state().phase, "approve");
  });

  test("without --record only reports", () => {
    init();
    const r = intake(fourUnits());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().recorded, false);
    assert.equal(r.json().order.length, 4);
    assert.equal(existsSync(join(runDir, "graph.json")), false);
    assert.deepEqual(jsonl("decisions.jsonl"), []);
    assert.equal(state().phase, "intake");
  });

  test("a cycle, an unknown dependency and a check without command list every error and write nothing", () => {
    init();
    const data = fourUnits();
    data.units[0].depends_on = ["app-presets"];
    data.units[1].depends_on.push("lib-ghost");
    delete data.units[2].command;
    const r = intake(data, "--record");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /3 errors/);
    assert.match(
      r.stderr,
      /unit lib-version\.depends_on: unknown unit "lib-ghost"/
    );
    assert.match(r.stderr, /unit lib-published: a check unit needs a command/);
    assert.match(
      r.stderr,
      /cycle: lib-presets -> app-presets -> lib-published -> lib-version -> lib-presets/
    );
    assert.equal(existsSync(join(runDir, "graph.json")), false);
    assert.deepEqual(jsonl("decisions.jsonl"), []);
    assert.equal(state().phase, "intake");
  });

  test("an unknown repository is listed as unresolved", () => {
    init();
    const data = fourUnits();
    data.units[3].repo = "o/ghost";
    const r = intake(data, "--record");
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().unresolved, [
      { id: "app-presets", repo: "o/ghost" }
    ]);
    assert.equal(graph().units[3].repo_dir, null);
  });

  test("resolves the project, a sibling and orchestrate.repos", () => {
    const mapped = join(tmp, "elsewhere", "tools");
    mkdirSync(mapped, { recursive: true });
    userConfig({ orchestrate: { repos: { "O/Tools": mapped } } });
    init();
    const data = fourUnits();
    data.units.push({
      id: "tools",
      kind: "build",
      repo: "o/tools",
      brief: "Bump the tools"
    });
    const r = intake(data, "--record");
    assert.equal(r.code, 0, r.stderr);
    const sources = Object.fromEntries(
      r.json().units.map((u) => [u.id, [u.repo_dir, u.repo_source]])
    );
    assert.deepEqual(sources["lib-presets"], [lib, "sibling"]);
    assert.deepEqual(sources["app-presets"], [app, "project"]);
    assert.deepEqual(sources.tools, [mapped, "config"]);
    assert.deepEqual(sources["lib-published"], [null, null]);
    assert.equal("repo_source" in graph().units[0], false);
  });

  test("a repo_dir given in the graph wins", () => {
    init();
    const data = fourUnits();
    data.units[3].repo_dir = lib;
    const r = intake(data, "--record");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(graph().units[3].repo_dir, lib);
  });

  test("records again while every unit is pending, never after one started", () => {
    init();
    assert.equal(intake(fourUnits(), "--record").code, 0);
    const smaller = { units: fourUnits().units.slice(0, 2) };
    const again = intake(smaller, "--record");
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(Object.keys(state().units), [
      "lib-presets",
      "lib-version"
    ]);
    assert.equal(graph().units.length, 2);

    const s = state();
    s.units["lib-presets"].status = "running";
    writeFileSync(join(runDir, "orchestrate.json"), JSON.stringify(s));
    const refused = intake(fourUnits(), "--record");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already running \(units lib-presets\)/);
    assert.equal(graph().units.length, 2);
  });

  test("needs init first and a --graph", () => {
    const before = intake(fourUnits(), "--record");
    assert.equal(before.code, 1);
    assert.match(before.stderr, /run "orchestrate.mjs init" first/);
    init();
    const missing = orchestrate("intake", "--record");
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /intake needs --graph/);
  });

  test("an unreadable graph file fails", () => {
    init();
    const path = join(tmp, "broken.json");
    writeFileSync(path, "{ units: ");
    const r = orchestrate("intake", "--graph", path, "--record");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid JSON/);
  });
});

describe("validateGraph", () => {
  const unit = (fields) => ({
    id: "u",
    kind: "build",
    repo: "o/r",
    brief: "Do it",
    ...fields
  });
  const errorsOf = (...units) => validateGraph({ units });

  test("accepts the four-unit graph", () => {
    assert.deepEqual(validateGraph(fourUnits()), []);
  });

  for (const [name, units, pattern] of [
    ["an empty graph", [], /units: expected a non-empty list/],
    ["a bad id", [unit({ id: "-bad" })], /id must be letters/],
    ["a duplicate id", [unit({}), unit({})], /unit u: duplicate id/],
    [
      "an unknown kind",
      [unit({ kind: "deploy" })],
      /unit u\.kind: expected one of/
    ],
    ["a missing repo", [unit({ repo: undefined })], /unit u\.repo: required/],
    ["a bad repo", [unit({ repo: "o" })], /unit u\.repo: expected owner\/name/],
    [
      "a build without brief",
      [unit({ brief: "" })],
      /a build unit needs a brief/
    ],
    [
      "an adopt without pull request",
      [unit({ kind: "adopt", pr: "#12" })],
      /an adopt unit needs a pull request URL/
    ],
    [
      "an adopt of another repository",
      [unit({ kind: "adopt", pr: "https://github.com/o/other/pull/1" })],
      /is not a pull request of o\/r/
    ],
    [
      "an await-pr without match",
      [unit({ kind: "await-pr", match: { base: "main" } })],
      /needs match\.head or match\.author/
    ],
    [
      "an await-pr with a bad title pattern",
      [unit({ kind: "await-pr", match: { head: "x", title: "(" } })],
      /match\.title: invalid regular expression/
    ],
    [
      "a check without command",
      [unit({ kind: "check" })],
      /a check unit needs a command/
    ],
    [
      "an unknown dependency",
      [unit({ depends_on: ["v"] })],
      /unknown unit "v"/
    ],
    ["a self dependency", [unit({ depends_on: ["u"] })], /depends on itself/],
    ["a bad role", [unit({ role: "docs" })], /unit u\.role: expected one of/],
    ["a bad plan", [unit({ plan: "inline" })], /unit u\.plan: expected one of/],
    [
      "a bad merge setting",
      [unit({ settings: { merge: "bot" } })],
      /settings\.merge: expected one of auto, human, none/
    ],
    [
      "a bad review setting",
      [unit({ settings: { review: "always" } })],
      /settings\.review: expected one of/
    ],
    [
      "a bad checks setting",
      [unit({ settings: { checks: "some" } })],
      /settings\.checks: expected one of required, none-expected/
    ],
    [
      "a bad max_rounds setting",
      [unit({ settings: { max_rounds: 0 } })],
      /settings\.max_rounds: expected an integer >= 1/
    ],
    [
      "a bad reviewers setting",
      [unit({ settings: { reviewers: "copilot" } })],
      /settings\.reviewers: expected a list/
    ],
    [
      "an unknown setting",
      [unit({ settings: { merge_method: "squash" } })],
      /settings\.merge_method: unknown setting/
    ]
  ])
    test(`reports ${name}`, () => {
      const errors = errorsOf(...units);
      assert.ok(
        errors.some((e) => pattern.test(e)),
        `expected ${pattern} in ${JSON.stringify(errors)}`
      );
    });

  test("a check needs no repository", () => {
    assert.deepEqual(
      errorsOf(unit({ kind: "check", repo: undefined, command: "true" })),
      []
    );
  });

  test("names each cycle once", () => {
    const errors = errorsOf(
      unit({ id: "a", depends_on: ["c"] }),
      unit({ id: "b", depends_on: ["a"] }),
      unit({ id: "c", depends_on: ["b"] }),
      unit({ id: "d", depends_on: ["e"] }),
      unit({ id: "e", depends_on: ["d"] })
    );
    assert.deepEqual(errors, ["cycle: a -> c -> b -> a", "cycle: d -> e -> d"]);
  });

  test("findCycles is empty for a DAG", () => {
    assert.deepEqual(
      findCycles([
        { id: "a", depends_on: [] },
        { id: "b", depends_on: ["a"] },
        { id: "c", depends_on: ["a", "b"] }
      ]),
      []
    );
  });
});

describe("topoOrder", () => {
  test("orders by dependency and keeps the graph order among ready units", () => {
    assert.deepEqual(
      topoOrder({
        units: [
          { id: "app", depends_on: ["lib", "tools"] },
          { id: "lib", depends_on: [] },
          { id: "docs", depends_on: ["app"] },
          { id: "tools" }
        ]
      }),
      ["lib", "tools", "app", "docs"]
    );
  });

  test("throws on a cycle", () => {
    assert.throws(
      () =>
        topoOrder({
          units: [
            { id: "a", depends_on: ["b"] },
            { id: "b", depends_on: ["a"] }
          ]
        }),
      /cycle among a, b/
    );
  });
});

describe("normalizeUnit", () => {
  test("keeps an explicit plan path and leaves non-build units unplanned", () => {
    const opts = { runDir: "/run", mergePolicy: "auto", maxRounds: 3 };
    assert.equal(
      normalizeUnit(
        { id: "a", kind: "build", plan: "master", plan_path: "/p.md" },
        opts
      ).plan_path,
      "/p.md"
    );
    const check = normalizeUnit({ id: "c", kind: "check", command: "x" }, opts);
    assert.equal(check.plan, null);
    assert.equal(check.repo, null);
    assert.equal(check.command, "x");
  });
});

describe("repoOfRemote", () => {
  for (const [url, repo] of [
    ["https://github.com/o/app.git", "o/app"],
    ["https://github.com/o/app", "o/app"],
    ["https://github.com/o/app/", "o/app"],
    ["https://x-access-token:t@github.com/o/app.git", "o/app"],
    ["git@github.com:o/app.git", "o/app"],
    ["ssh://git@github.com/o/app.git", "o/app"],
    ["ssh://git@github.example.com:2222/team/my.repo.git", "team/my.repo"],
    ["/srv/git/app.git", null],
    ["", null]
  ])
    test(`${url || "(empty)"} -> ${repo}`, () => {
      assert.equal(repoOfRemote(url), repo);
    });
});

describe("partial run status", () => {
  test("runs.mjs update --status partial sets ended_at", () => {
    const r = cli(RUNS, ["update", "--run-dir", runDir, "--status", "partial"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().status, "partial");
    assert.equal(r.json().ended_at, NOW);
    assert.equal(cli(RUNS, ["check", join(runDir, "run.json")]).code, 0);
  });

  test("runs.mjs check accepts a partial summary", () => {
    const path = join(runDir, "summary.md");
    writeFileSync(
      path,
      `---\ntask: ${runDir.split(/[\\/]/).at(-1)}\ntitle: "Ship the presets"\nstatus: partial\nworkflow: esp-orchestrate\n---\n\n# Ship the presets\n`
    );
    const r = cli(RUNS, ["check", path]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json().valid, true);
  });
});
