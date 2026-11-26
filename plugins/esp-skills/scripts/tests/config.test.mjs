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
import {
  ConfigError,
  DEFAULTS_PATH,
  SCHEMA_PATH,
  SCHEMA_URL,
  deepMerge,
  expandHome,
  getValue,
  layerPaths,
  loadConfig,
  parseValue,
  runSnapshot,
  setValue
} from "../config.mjs";
import { validate } from "../lib/json-schema.mjs";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "config.mjs"
);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
};

let root;
let home;
let project;
let env;

function cli(...args) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...args, "--project-dir", project],
    {
      env: { ...process.env, ESP_SKILLS_HOME: home },
      encoding: "utf8"
    }
  );
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: () => JSON.parse(result.stdout)
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "esp-config-"));
  home = join(root, "home");
  project = join(root, "repo");
  mkdirSync(project, { recursive: true });
  env = { ESP_SKILLS_HOME: home };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("schema and defaults", () => {
  test("config.schema.json validates config-defaults.json", () => {
    const result = validate(readJson(SCHEMA_PATH), readJson(DEFAULTS_PATH));
    assert.deepEqual(result.errors, []);
  });

  test("$schema URL of the defaults matches the schema $id and published path", () => {
    const schema = readJson(SCHEMA_PATH);
    const defaults = readJson(DEFAULTS_PATH);
    assert.equal(defaults.$schema, schema.$id);
    assert.equal(schema.$id, SCHEMA_URL);
    assert.ok(
      SCHEMA_URL.endsWith("/plugins/esp-skills/references/config.schema.json")
    );
  });

  test("ship and fix-review.wait declare every esp-ship key with its default", () => {
    const { ship, "fix-review": fixReview } = readJson(DEFAULTS_PATH);
    assert.equal(ship.plan_mode, "auto");
    assert.equal(ship.review_mode, "auto");
    assert.deepEqual(ship.auto, { review_max_files: 3, review_max_lines: 150 });
    assert.ok(ship.review.always_paths.length > 0);
    assert.equal(ship.internal_review_rounds, 2);
    assert.equal(ship.worktree, false);
    assert.equal(ship.dirty_tree, "worktree");
    assert.equal(ship.halt_on.length, 5);
    assert.deepEqual(ship.inline, { max_files_changed: 10, escalate: true });
    assert.deepEqual(ship.budgets, {
      inline: { max_wall_minutes: 60 },
      orchestrated: { max_wall_minutes: 240, max_milestones: 12 }
    });
    assert.equal(ship.max_retries_per_milestone, 2);
    assert.equal(ship.parallel, "auto");
    assert.equal(ship.max_parallel, 3);
    assert.equal(ship.commit_per_milestone, true);
    assert.equal(ship.gates_scope, "milestone");
    assert.deepEqual(ship.gates.always, []);
    assert.equal(ship.gates.test, null);
    assert.deepEqual(ship.reuse, {
      limit_tokens: 250000,
      cost: { low: 40000, medium: 70000, high: 120000 }
    });
    assert.equal(ship.phases, undefined);
    assert.deepEqual(fixReview.wait.default_reviewers, ["claude"]);
    assert.equal(fixReview.wait.reviewers.claude.login, "claude[bot]");
    assert.equal(fixReview.wait.timeout_minutes, 30);
    assert.equal(fixReview.wait.poll_seconds, 60);
    assert.equal(fixReview.wait.auto_trigger, false);
    assert.equal(fixReview.wait.checks_grace_seconds, 120);
  });

  test("ralph declares the loop defaults and rejects invalid values", () => {
    const { ralph } = readJson(DEFAULTS_PATH);
    assert.deepEqual(ralph, {
      max_iterations: 25,
      no_progress_limit: 2,
      allow_subagents: false
    });
    const schema = readJson(SCHEMA_PATH);
    for (const config of [
      { ralph: { max_iterations: 0 } },
      { ralph: { no_progress_limit: 1.5 } },
      { ralph: { allow_subagents: "yes" } },
      { ralph: { model: "opus" } }
    ])
      assert.notDeepEqual(
        validate(schema, config).errors,
        [],
        JSON.stringify(config)
      );
    assert.deepEqual(
      validate(schema, { ralph: { max_iterations: 5, allow_subagents: true } })
        .errors,
      []
    );
  });

  test("orchestrate declares the defaults and rejects invalid values", () => {
    const { orchestrate } = readJson(DEFAULTS_PATH);
    assert.deepEqual(orchestrate, {
      repos: {},
      unit_mode: "auto",
      max_parallel: 2,
      wait: { timeout_minutes: 60, interval_seconds: 30 },
      housekeeping: true,
      write_back: true
    });
    const schema = readJson(SCHEMA_PATH);
    for (const config of [
      { orchestrate: { unit_mode: "x" } },
      { orchestrate: { max_parallel: 0 } },
      { orchestrate: { max_parallel: 5 } },
      { orchestrate: { parallel: 2 } },
      { orchestrate: { repos: { skills: "/work/skills" } } },
      { orchestrate: { wait: { timeout_minutes: 0 } } }
    ])
      assert.notDeepEqual(
        validate(schema, config).errors,
        [],
        JSON.stringify(config)
      );
    assert.deepEqual(
      validate(schema, {
        orchestrate: {
          repos: { "acme/skills": "/work/skills" },
          unit_mode: "inline",
          max_parallel: 4
        }
      }).errors,
      []
    );
  });

  test("codex declares the run defaults and rejects invalid values", () => {
    const { codex, defaults } = readJson(DEFAULTS_PATH);
    assert.deepEqual(codex, {
      model: null,
      sandbox: "read-only",
      timeout_minutes: 30
    });
    assert.deepEqual(defaults.models.relay, { model: "haiku" });
    const schema = readJson(SCHEMA_PATH);
    for (const config of [
      { codex: { sandbox: "danger-full-access" } },
      { codex: { timeout_minutes: 0 } },
      { codex: { model: "" } },
      { codex: { approval: "never" } },
      { defaults: { models: { relay: { model: "gpt" } } } }
    ])
      assert.notDeepEqual(
        validate(schema, config).errors,
        [],
        JSON.stringify(config)
      );
    assert.deepEqual(
      validate(schema, {
        codex: {
          model: "gpt-5.4",
          sandbox: "workspace-write",
          timeout_minutes: 45
        }
      }).errors,
      []
    );
  });

  test("review.second_opinion defaults to none and accepts only codex", () => {
    const { review } = readJson(DEFAULTS_PATH);
    assert.equal(review.second_opinion, "none");
    const schema = readJson(SCHEMA_PATH);
    assert.deepEqual(
      validate(schema, { review: { second_opinion: "codex" } }).errors,
      []
    );
    assert.notDeepEqual(
      validate(schema, { review: { second_opinion: "gemini" } }).errors,
      []
    );
  });

  test("ship.merge_policy and merge.human_wait_minutes declare their defaults and reject invalid values", () => {
    const defaults = readJson(DEFAULTS_PATH);
    assert.equal(defaults.ship.merge_policy, "auto");
    assert.equal(defaults.merge.human_wait_minutes, 1440);
    const schema = readJson(SCHEMA_PATH);
    for (const policy of ["auto", "human", "none"])
      assert.deepEqual(
        validate(schema, { ship: { merge_policy: policy } }).errors,
        [],
        policy
      );
    for (const config of [
      { ship: { merge_policy: "manual" } },
      { merge: { human_wait_minutes: 0 } },
      { merge: { human_wait_minutes: 1.5 } },
      { merge: { human_wait_minutes: "1440" } }
    ])
      assert.notDeepEqual(
        validate(schema, config).errors,
        [],
        JSON.stringify(config)
      );
  });

  test("the replaced sections are gone and await-review is not a ship phase", () => {
    const schema = readJson(SCHEMA_PATH);
    for (const key of ["go", "go-light", "build", "await-review"])
      assert.equal(schema.properties[key], undefined, key);
    const phases = schema.properties.ship.properties.phases.items.enum;
    assert.ok(phases.includes("implement") && phases.includes("build"));
    assert.ok(!phases.includes("await-review"));
  });

  test("ship enums reject unknown modes", () => {
    const schema = readJson(SCHEMA_PATH);
    for (const config of [
      { ship: { plan_mode: "never" } },
      { ship: { review_mode: "bots" } },
      { ship: { parallel: true } },
      { ship: { dirty_tree: "stash" } },
      { ship: { gates_scope: "none" } },
      { ship: { gates: { always: ["format"] } } },
      { ship: { phases: ["await-review"] } },
      { go: { worktree: true } }
    ])
      assert.notDeepEqual(
        validate(schema, config).errors,
        [],
        JSON.stringify(config)
      );
  });
});

describe("helpers", () => {
  test("deepMerge merges objects and replaces arrays and null", () => {
    const merged = deepMerge(
      { a: { b: 1, c: [1, 2] }, d: "x", e: { f: 1 } },
      { a: { c: [3] }, e: null, g: true }
    );
    assert.deepEqual(merged, { a: { b: 1, c: [3] }, d: "x", e: null, g: true });
  });

  test("getValue and setValue use dotted paths", () => {
    const config = setValue({}, "a.b.c", 1);
    assert.deepEqual(config, { a: { b: { c: 1 } } });
    assert.equal(getValue(config, "a.b.c"), 1);
    assert.equal(getValue(config, "a.x"), undefined);
    assert.deepEqual(setValue(config, "a.b.c", undefined), { a: { b: {} } });
  });

  test("parseValue reads JSON and falls back to strings", () => {
    assert.equal(parseValue("true"), true);
    assert.equal(parseValue("3"), 3);
    assert.equal(parseValue("null"), null);
    assert.deepEqual(parseValue('["a"]'), ["a"]);
    assert.equal(parseValue("develop"), "develop");
  });

  test("expandHome expands a leading tilde only", () => {
    assert.equal(expandHome("~/runs", "/h"), join("/h", "runs"));
    assert.equal(expandHome("/abs/~/x", "/h"), "/abs/~/x");
  });
});

describe("layering", () => {
  test("missing user and project files fall back to defaults", () => {
    const { config, layers } = loadConfig({ projectDir: project, env });
    assert.deepEqual(config.branch, readJson(DEFAULTS_PATH).branch);
    assert.deepEqual(
      layers.map((l) => [l.layer, l.used]),
      [
        ["defaults", true],
        ["user", false],
        ["project", false]
      ]
    );
  });

  test("project overrides user, which overrides defaults", () => {
    writeJson(join(home, "config.json"), {
      version: 1,
      pr: { draft: true, base: "develop" },
      commit: { style: "conventional" }
    });
    writeJson(join(project, ".esp-skills", "config.json"), {
      pr: { base: "trunk" }
    });
    const { config } = loadConfig({ projectDir: project, env });
    assert.equal(config.pr.base, "trunk");
    assert.equal(config.pr.draft, true);
    assert.equal(config.pr.attribution, true);
    assert.equal(config.commit.style, "conventional");
  });

  test("a snapshot replaces the user and project layers", () => {
    writeJson(join(home, "config.json"), { pr: { draft: true } });
    writeJson(join(project, ".esp-skills", "config.json"), {
      pr: { base: "trunk" }
    });
    const snapshot = join(root, "snapshot.json");
    writeJson(snapshot, { pr: { base: "release" } });
    const { config, layers } = loadConfig({
      projectDir: project,
      snapshot,
      env
    });
    assert.equal(config.pr.base, "release");
    assert.equal(config.pr.draft, false);
    assert.deepEqual(
      layers.filter((l) => l.used).map((l) => l.layer),
      ["defaults", "snapshot"]
    );
  });

  test("a missing snapshot fails", () => {
    assert.throws(
      () =>
        loadConfig({
          projectDir: project,
          snapshot: join(root, "none.json"),
          env
        }),
      /snapshot not found/
    );
  });
});

describe("base snapshot layer", () => {
  test("the project layer wins over the base, which replaces the user layer", () => {
    writeJson(join(home, "config.json"), {
      pr: { draft: true },
      commit: { style: "conventional" }
    });
    writeJson(join(project, ".esp-skills", "config.json"), {
      pr: { base: "trunk" }
    });
    const base = join(root, "parent", "config.snapshot.json");
    writeJson(base, {
      pr: { base: "release", attribution: false },
      ship: { merge_policy: "human" }
    });
    const { config, layers } = loadConfig({ projectDir: project, base, env });
    assert.equal(config.pr.base, "trunk");
    assert.equal(config.pr.attribution, false);
    assert.equal(config.ship.merge_policy, "human");
    assert.equal(config.pr.draft, false);
    assert.equal(config.commit.style, "plain");
    assert.deepEqual(
      layers.map((l) => [l.layer, l.used]),
      [
        ["defaults", true],
        ["user", false],
        ["base", true],
        ["project", true]
      ]
    );
    assert.equal(layers.find((l) => l.layer === "base").path, base);
  });

  test("a base without a project layer still ignores the user layer", () => {
    writeJson(join(home, "config.json"), { pr: { draft: true } });
    const base = join(root, "base.json");
    writeJson(base, { analyze: { output_dir: "reports" } });
    const { config } = loadConfig({ projectDir: project, base, env });
    assert.equal(config.analyze.output_dir, "reports");
    assert.equal(config.pr.draft, false);
  });

  test("a missing base file raises a ConfigError", () => {
    assert.throws(
      () =>
        loadConfig({ projectDir: project, base: join(root, "none.json"), env }),
      (err) =>
        err instanceof ConfigError &&
        /base snapshot not found/.test(err.message)
    );
  });

  test("an invalid base file fails validation", () => {
    const base = join(root, "base.json");
    writeJson(base, { ship: { merge_policy: "manual" } });
    assert.throws(
      () => loadConfig({ projectDir: project, base, env }),
      (err) => err instanceof ConfigError && /merge_policy/.test(err.message)
    );
  });

  test("layerPaths resolves the base path, null without one", () => {
    const base = join(root, "base.json");
    assert.equal(layerPaths({ projectDir: project, base, env }).base, base);
    assert.equal(layerPaths({ projectDir: project, env }).base, null);
  });
});

describe("cli get and show", () => {
  test("get ship.merge_policy prints auto with no user or project config", () => {
    const result = cli("get", "ship.merge_policy");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "auto");
  });

  test("get <skill> prints the merged section as JSON", () => {
    writeJson(join(project, ".esp-skills", "config.json"), {
      analyze: { output_dir: "reports" }
    });
    const result = cli("get", "analyze");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.json(), { output_dir: "reports" });
  });

  test("get accepts dotted keys", () => {
    const result = cli("get", "defaults.models.builder.high");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.json(), { model: "opus", effort: "high" });
  });

  test("get of an unknown key exits 2", () => {
    const result = cli("get", "nope");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unknown config key: nope/);
  });

  test("show output is a valid snapshot", () => {
    writeJson(join(home, "config.json"), { pr: { draft: true } });
    const shown = cli("show");
    assert.equal(shown.code, 0, shown.stderr);
    const snapshot = join(root, "snap.json");
    writeFileSync(snapshot, shown.stdout);
    rmSync(join(home, "config.json"));
    assert.equal(loadConfig({ snapshot, env }).config.pr.draft, true);
  });

  test("sources lists every layer", () => {
    const result = cli("sources");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.json().map((l) => l.layer),
      ["defaults", "user", "project"]
    );
  });
});

describe("run directory snapshot", () => {
  const live = () => {
    writeJson(join(home, "config.json"), { pr: { draft: true } });
    writeJson(join(project, ".esp-skills", "config.json"), {
      pr: { base: "trunk" }
    });
  };

  test("--run-dir uses the run's config.snapshot.json in place of the user and project layers", () => {
    live();
    const runDir = join(root, "run");
    writeJson(join(runDir, "config.snapshot.json"), {
      pr: { base: "release" }
    });
    const pr = cli("get", "pr", "--run-dir", runDir);
    assert.equal(pr.code, 0, pr.stderr);
    assert.equal(pr.json().base, "release");
    assert.equal(pr.json().draft, false);
    const shown = cli("show", "--run-dir", runDir);
    assert.equal(shown.json().pr.base, "release");
    const sources = cli("sources", "--run-dir", runDir).json();
    assert.deepEqual(
      sources.filter((l) => l.used).map((l) => l.layer),
      ["defaults", "snapshot"]
    );
  });

  test("--run-dir prefers the snapshot path recorded in ship.json", () => {
    const runDir = join(root, "run");
    const recorded = join(root, "elsewhere", "frozen.json");
    writeJson(recorded, { pr: { base: "recorded" } });
    writeJson(join(runDir, "config.snapshot.json"), { pr: { base: "file" } });
    writeJson(join(runDir, "ship.json"), { config_snapshot: recorded });
    assert.equal(runSnapshot(runDir), recorded);
    assert.equal(cli("get", "pr", "--run-dir", runDir).json().base, "recorded");
  });

  test("--run-dir without a snapshot falls back to the live layers", () => {
    live();
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    assert.equal(runSnapshot(runDir), null);
    const pr = cli("get", "pr", "--run-dir", runDir).json();
    assert.equal(pr.base, "trunk");
    assert.equal(pr.draft, true);
  });

  test("--run-dir of a missing directory fails", () => {
    const result = cli("get", "pr", "--run-dir", join(root, "none"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Run directory not found/);
  });
});

describe("invalid config", () => {
  test("a wrong type fails with the key path, expected type and source", () => {
    writeJson(join(home, "config.json"), { pr: { draft: "yes" } });
    const result = cli("get", "pr");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /config\.json/);
    assert.match(
      result.stderr,
      /pr\.draft: expected boolean, got string "yes"/
    );
  });

  test("an invalid enum value lists the allowed values", () => {
    writeJson(join(project, ".esp-skills", "config.json"), {
      review: { min_severity: "urgent" }
    });
    const result = cli("get", "review");
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /review\.min_severity: expected one of "low", "medium", "high", "critical"/
    );
  });

  test("an unknown key is rejected", () => {
    writeJson(join(home, "config.json"), { branch: { patern: "x" } });
    const result = cli("validate");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /branch\.patern: is not a known key/);
  });

  test("nested model choices are validated", () => {
    writeJson(join(home, "config.json"), {
      defaults: { models: { builder: { low: { model: "gpt" } } } }
    });
    const result = cli("validate");
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /defaults\.models\.builder\.low\.model: expected one of/
    );
  });

  test("malformed JSON fails loudly", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), "{ not json");
    const result = cli("show");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid JSON/);
  });
});

describe("cli init, set, unset, validate", () => {
  test("init creates a starter user file and is idempotent", () => {
    const first = cli("init");
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json().created, true);
    assert.deepEqual(readJson(join(home, "config.json")), {
      $schema: SCHEMA_URL,
      version: 1
    });
    const second = cli("init");
    assert.equal(second.json().created, false);
    const forced = cli("init", "--force");
    assert.equal(forced.json().created, true);
  });

  test("init --project writes the project file", () => {
    const result = cli("init", "--project");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      readJson(join(project, ".esp-skills", "config.json")).version,
      1
    );
  });

  test("set writes typed values and get reads them back", () => {
    assert.equal(cli("set", "pr.draft", "true").code, 0);
    assert.equal(cli("set", "pr.base", "develop", "--project").code, 0);
    assert.equal(readJson(join(home, "config.json")).pr.draft, true);
    assert.equal(
      readJson(join(project, ".esp-skills", "config.json")).pr.base,
      "develop"
    );
    const pr = cli("get", "pr").json();
    assert.equal(pr.draft, true);
    assert.equal(pr.base, "develop");
  });

  test("set rejects an invalid value and leaves the file unchanged", () => {
    cli("set", "pr.draft", "true");
    const result = cli("set", "pr.draft", "maybe");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /pr\.draft: expected boolean/);
    assert.equal(readJson(join(home, "config.json")).pr.draft, true);
  });

  test("set rejects an unknown key", () => {
    const result = cli("set", "nope.key", "1");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /nope: is not a known key/);
  });

  test("unset removes a key", () => {
    cli("set", "pr.draft", "true");
    const result = cli("unset", "pr.draft");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json().removed, true);
    assert.equal(cli("get", "pr.draft").json(), false);
  });

  test("validate checks a single file", () => {
    const file = join(root, "candidate.json");
    writeJson(file, { merge: { method: "fast-forward" } });
    const bad = cli("validate", file);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /merge\.method/);
    writeJson(file, { merge: { method: "squash" } });
    assert.equal(cli("validate", file).code, 0);
  });

  test("validate --file checks the named file", () => {
    const file = join(root, "candidate.json");
    writeJson(file, { merge: { method: "fast-forward" } });
    const bad = cli("validate", "--file", file);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /merge.method/);
    writeJson(file, { merge: { method: "squash" } });
    const good = cli("validate", "--file", file);
    assert.equal(good.code, 0, good.stderr);
    assert.deepEqual(good.json().files, [file]);
  });

  test("validate reports a missing file", () => {
    const result = cli("validate", join(root, "missing.json"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /File not found/);
  });

  test("usage errors exit 2", () => {
    assert.equal(cli("frobnicate").code, 2);
    assert.equal(cli("set", "pr.draft").code, 2);
    assert.equal(cli("get", "--bogus").code, 2);
  });
});
