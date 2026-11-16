import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NOTES_MAX_LENGTH,
  indexRuns,
  latestPlan,
  readNotes,
  slugify,
  checkFile
} from "../runs.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "runs.mjs");
const NOW = "2026-11-10T12:00:00.000Z";

// What runs.mjs writes for createRun() and for a decision given without id and at.
const GOLDEN = {
  run: {
    id: "2026-11-10-fix-login-timeout",
    type: "skill",
    title: "Fix login timeout",
    workflow: "esp-go-light",
    parent: null,
    repo: "e-stpierre/skills",
    base: "main",
    branch: null,
    worktree: null,
    pr: null,
    runtime: null,
    status: "running",
    max_risk: null,
    started_at: NOW,
    updated_at: NOW,
    ended_at: null,
    models: {},
    budgets_used: {}
  },
  decision: {
    id: "D001",
    at: NOW,
    phase: "build",
    source: "agent",
    risk: "medium",
    decision: "Reuse the existing HTTP client instead of adding axios",
    rationale:
      "The project already wraps fetch with retries; a second client would duplicate it",
    alternatives: ["Add axios"],
    files: ["src/http.ts"],
    commit: null
  }
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readJsonl = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const golden = (kind) => structuredClone(GOLDEN[kind]);

let root;
let home;
let project;

function cli(args, { input, now = NOW } = {}) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...args, "--project-dir", project],
    {
      env: { ...process.env, ESP_SKILLS_HOME: home, ESP_RUNS_NOW: now },
      encoding: "utf8",
      input: input ?? ""
    }
  );
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: () => JSON.parse(result.stdout)
  };
}

function createRun(extra = []) {
  const out = cli([
    "create",
    "Fix login timeout",
    "--root",
    join(root, "runs"),
    "--title",
    "Fix login timeout",
    "--workflow",
    "esp-go-light",
    "--repo",
    "e-stpierre/skills",
    "--base",
    "main",
    ...extra
  ]);
  assert.equal(out.code, 0, out.stderr);
  return out.json().run_dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "esp-runs-"));
  home = join(root, "home");
  project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("create", () => {
  test("creates <root>/<date>-<slug> with a golden run.json and nothing else", () => {
    const dir = createRun();
    assert.equal(dir, join(root, "runs", "2026-11-10-fix-login-timeout"));
    assert.deepEqual(readJson(join(dir, "run.json")), golden("run"));
    assert.deepEqual(readdirSync(dir), ["run.json"]);
  });

  test("uses runs.root from the config when no root is given", () => {
    const runsRoot = join(root, "configured-runs");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ runs: { root: runsRoot } })
    );
    const out = cli(["create", "task"]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.json().run_dir, join(runsRoot, "2026-11-10-task"));
  });

  test("adds a numeric suffix when the directory exists", () => {
    createRun();
    const second = createRun();
    assert.equal(second, join(root, "runs", "2026-11-10-fix-login-timeout-2"));
  });

  test("--run-dir creates the given directory, and reuses an existing run", () => {
    const dir = join(root, "parent", "T01-add-oauth");
    const first = cli(["create", "--run-dir", dir, "--type", "workflow"]);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.json(), {
      run_dir: dir,
      id: "T01-add-oauth",
      created: true
    });
    const second = cli(["create", "--run-dir", dir]);
    assert.equal(second.json().created, false);
    assert.deepEqual(readdirSync(dir), ["run.json"]);
  });

  test("rejects an invalid type before writing anything", () => {
    const out = cli([
      "create",
      "x",
      "--root",
      join(root, "runs"),
      "--type",
      "job"
    ]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /type: expected one of/);
    assert.equal(existsSync(join(root, "runs", "2026-11-10-x")), false);
  });

  test("slugify keeps directory names safe", () => {
    assert.equal(
      slugify("Ajouter l'écran Été / v2!"),
      "ajouter-l-ecran-ete-v2"
    );
    assert.throws(() => slugify("!!!"), /slug/);
  });
});

describe("update", () => {
  test("sets fields and raises max_risk only", () => {
    const dir = createRun();
    let out = cli([
      "update",
      "--run-dir",
      dir,
      "--status",
      "paused",
      "--max-risk",
      "high"
    ]);
    assert.equal(out.code, 0, out.stderr);
    out = cli(
      ["update", "--run-dir", dir, "--max-risk", "low", "--status", "running"],
      {
        now: "2026-11-10T12:10:00.000Z"
      }
    );
    out = cli(
      [
        "update",
        "--run-dir",
        dir,
        "--status",
        "merged",
        "--pr",
        "https://github.com/e-stpierre/skills/pull/12",
        "--model",
        "builder=opus:high",
        "--budget",
        "wall_minutes=38"
      ],
      { now: "2026-11-10T12:38:00.000Z" }
    );
    assert.equal(out.code, 0, out.stderr);
    const run = out.json();
    assert.equal(run.status, "merged");
    assert.equal(run.max_risk, "high");
    assert.equal(run.ended_at, "2026-11-10T12:38:00.000Z");
    assert.deepEqual(run.models, {
      builder: { model: "opus", effort: "high" }
    });
    assert.deepEqual(run.budgets_used, { wall_minutes: 38 });
    assert.deepEqual(readdirSync(dir), ["run.json"]);
  });

  test("rejects an invalid status and leaves run.json untouched", () => {
    const dir = createRun();
    const before = readFileSync(join(dir, "run.json"), "utf8");
    const out = cli(["update", "--run-dir", dir, "--status", "finished"]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /status: expected one of/);
    assert.equal(readFileSync(join(dir, "run.json"), "utf8"), before);
  });

  test("requires a run directory", () => {
    assert.equal(cli(["update", "--status", "done"]).code, 2);
    assert.equal(cli(["get", "--run-dir", join(root, "nope")]).code, 1);
  });
});

describe("decisions", () => {
  const input = () => {
    const { id, at, ...rest } = golden("decision");
    return rest;
  };

  test("fills id and at, matches the golden fixture, and raises max_risk", () => {
    const dir = createRun();
    const out = cli([
      "decision",
      "--run-dir",
      dir,
      "--json",
      JSON.stringify(input())
    ]);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(out.json(), golden("decision"));
    assert.equal(readJson(join(dir, "run.json")).max_risk, "medium");
  });

  test("reads the entry from stdin", () => {
    const dir = createRun();
    const out = cli(["decision", "--run-dir", dir], {
      input: JSON.stringify(input())
    });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.json().id, "D001");
  });

  test("is append-only: earlier lines are never rewritten", () => {
    const dir = createRun();
    const path = join(dir, "decisions.jsonl");
    cli(["decision", "--run-dir", dir, "--json", JSON.stringify(input())]);
    const first = readFileSync(path, "utf8");
    cli([
      "decision",
      "--run-dir",
      dir,
      "--json",
      JSON.stringify({ ...input(), risk: "low" })
    ]);
    const second = readFileSync(path, "utf8");
    assert.ok(second.startsWith(first));
    assert.deepEqual(
      readJsonl(path).map((d) => d.id),
      ["D001", "D002"]
    );
  });

  test("an invalid entry is rejected and nothing is appended", () => {
    const dir = createRun();
    const out = cli([
      "decision",
      "--run-dir",
      dir,
      "--json",
      JSON.stringify({ ...input(), source: "model" })
    ]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /source: expected one of/);
    assert.equal(existsSync(join(dir, "decisions.jsonl")), false);
  });

  test("concurrent appends keep every line whole with unique ids", async () => {
    const dir = createRun();
    const workers = 12;
    const perWorker = 5;
    const runWorker = (w) =>
      new Promise((resolvePromise, reject) => {
        const code = `
          const { appendDecision } = await import(${JSON.stringify(
            new URL("../runs.mjs", import.meta.url).href
          )});
          for (let i = 0; i < ${perWorker}; i++) {
            appendDecision(${JSON.stringify(dir)}, {
              phase: "build", source: "agent", risk: "low",
              decision: "worker ${w} decision " + i + " " + "x".repeat(2000),
              rationale: "concurrency test"
            });
          }`;
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", code],
          {
            env: { ...process.env, ESP_RUNS_NOW: NOW },
            stdio: ["ignore", "ignore", "pipe"]
          }
        );
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += d;
        });
        child.on("exit", (status) =>
          status === 0 ? resolvePromise() : reject(new Error(stderr))
        );
      });
    await Promise.all(Array.from({ length: workers }, (_, w) => runWorker(w)));
    const entries = readJsonl(join(dir, "decisions.jsonl"));
    assert.equal(entries.length, workers * perWorker);
    const ids = new Set(entries.map((e) => e.id));
    assert.equal(ids.size, workers * perWorker);
    assert.equal(checkFile(join(dir, "decisions.jsonl")).valid, true);
    assert.equal(existsSync(join(dir, "decisions.jsonl.lock")), false);
  });
});

describe("plans", () => {
  test("plan returns the latest version", () => {
    const dir = createRun();
    assert.deepEqual(latestPlan(dir), { path: null, version: 0, versions: [] });
    writeFileSync(join(dir, "plan.md"), "# v1");
    writeFileSync(join(dir, "plan.v3.md"), "# v3");
    writeFileSync(join(dir, "plan.v2.md"), "# v2");
    const out = cli(["plan", "--run-dir", dir]).json();
    assert.equal(out.version, 3);
    assert.equal(out.path, join(dir, "plan.v3.md"));
  });

  test("the removed operator channels are unknown commands", () => {
    const dir = createRun();
    for (const command of ["send", "messages", "deliver", "amend", "event"]) {
      const out = cli([command, "--run-dir", dir, "--text", "x"]);
      assert.equal(out.code, 2, command);
      assert.match(out.stderr, /Unknown command/);
    }
    assert.deepEqual(readdirSync(dir), ["run.json"]);
  });
});

describe("notes", () => {
  test("appends one line per note and shows them in order", () => {
    const dir = createRun();
    const show = () => cli(["notes", "--show", "--run-dir", dir]);
    assert.deepEqual(show().json().entries, []);
    const first = cli([
      "notes",
      "--append",
      "Run the API tests with\n  pnpm test:api",
      "--milestone",
      "M1",
      "--run-dir",
      dir
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.json().entry, {
      milestone: "M1",
      from: "agent",
      text: "Run the API tests with pnpm test:api"
    });
    cli([
      "notes",
      "--append",
      "Fixtures live in tests/fixtures",
      "--milestone",
      "M2",
      "--run-dir",
      dir
    ]);
    const path = join(dir, "notes.md");
    assert.equal(
      readFileSync(path, "utf8"),
      "# Run Notes\n\n- **M1**: Run the API tests with pnpm test:api\n- **M2**: Fixtures live in tests/fixtures\n"
    );
    const out = show().json();
    assert.equal(out.count, 2);
    assert.deepEqual(
      out.entries.map((e) => e.milestone),
      ["M1", "M2"]
    );
    const m2 = cli(["notes", "--show", "--milestone", "M2", "--run-dir", dir]);
    assert.deepEqual(m2.json().entries, [
      {
        milestone: "M2",
        from: "agent",
        text: "Fixtures live in tests/fixtures"
      }
    ]);
    assert.equal(existsSync(`${path}.lock`), false);
    assert.equal(readNotes(dir).length, 2);
  });

  test("an operator line with no milestone applies to the whole run", () => {
    const dir = createRun();
    cli([
      "notes",
      "--append",
      "Builder fact",
      "--milestone",
      "M1",
      "--run-dir",
      dir
    ]);
    const op = cli([
      "notes",
      "--append",
      "Keep the public API unchanged",
      "--from",
      "operator",
      "--run-dir",
      dir
    ]);
    assert.equal(op.code, 0, op.stderr);
    assert.deepEqual(op.json().entry, {
      milestone: null,
      from: "operator",
      text: "Keep the public API unchanged"
    });
    cli(["notes", "--append", "Iteration 2 done", "--run-dir", dir]);
    cli([
      "notes",
      "--append",
      "Other fact",
      "--milestone",
      "M2",
      "--run-dir",
      dir
    ]);
    assert.equal(
      readFileSync(join(dir, "notes.md"), "utf8"),
      "# Run Notes\n\n- **M1**: Builder fact\n- **run** (operator): Keep the public API unchanged\n- **run**: Iteration 2 done\n- **M2**: Other fact\n"
    );
    const m1 = cli(["notes", "--show", "--milestone", "M1", "--run-dir", dir]);
    assert.deepEqual(m1.json().entries, [
      { milestone: "M1", from: "agent", text: "Builder fact" },
      {
        milestone: null,
        from: "operator",
        text: "Keep the public API unchanged"
      },
      { milestone: null, from: "agent", text: "Iteration 2 done" }
    ]);
    assert.equal(
      cli(["notes", "--append", "x", "--from", "user", "--run-dir", dir]).code,
      2
    );
    assert.equal(
      cli(["notes", "--append", "x", "--milestone", "run", "--run-dir", dir])
        .code,
      2
    );
  });

  test("rejects a bad milestone, an empty or long text, and bad usage", () => {
    const dir = createRun();
    const usage = [
      ["notes", "--run-dir", dir],
      [
        "notes",
        "--show",
        "--append",
        "x",
        "--milestone",
        "M1",
        "--run-dir",
        dir
      ],
      ["notes", "--append", "x", "--milestone", "bad id", "--run-dir", dir],
      ["notes", "--append", "  ", "--milestone", "M1", "--run-dir", dir],
      [
        "notes",
        "--append",
        "x".repeat(NOTES_MAX_LENGTH + 1),
        "--milestone",
        "M1",
        "--run-dir",
        dir
      ]
    ];
    for (const args of usage) assert.equal(cli(args).code, 2, args.join(" "));
    assert.equal(existsSync(join(dir, "notes.md")), false);
    assert.equal(cli(["notes", "--show", "--run-dir", root]).code, 1);
  });

  test("concurrent appends keep every note whole", async () => {
    const dir = createRun();
    const workers = 8;
    const perWorker = 5;
    const runWorker = (w) =>
      new Promise((resolvePromise, reject) => {
        const code = `
          const { appendNote } = await import(${JSON.stringify(
            new URL("../runs.mjs", import.meta.url).href
          )});
          for (let i = 0; i < ${perWorker}; i++) {
            appendNote(${JSON.stringify(dir)}, "M${w}", "note " + i + " " + "y".repeat(400));
          }`;
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", code],
          { stdio: ["ignore", "ignore", "pipe"] }
        );
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += d;
        });
        child.on("exit", (status) =>
          status === 0 ? resolvePromise() : reject(new Error(stderr))
        );
      });
    await Promise.all(Array.from({ length: workers }, (_, w) => runWorker(w)));
    const text = readFileSync(join(dir, "notes.md"), "utf8");
    assert.equal(text.match(/# Run Notes/g).length, 1);
    const entries = readNotes(dir);
    assert.equal(entries.length, workers * perWorker);
    for (const e of entries) assert.match(e.text, /^note \d y{400}$/);
    for (let w = 0; w < workers; w++)
      assert.equal(entries.filter((e) => e.milestone === `M${w}`).length, 5);
    assert.equal(existsSync(join(dir, "notes.md.lock")), false);
  });
});

describe("pr-body", () => {
  test("renders the body from the run artifacts, per pr.body_sections", () => {
    const dir = createRun();
    cli([
      "decision",
      "--run-dir",
      dir,
      "--json",
      JSON.stringify({
        phase: "build",
        source: "agent",
        risk: "medium",
        decision: "Use a session cookie",
        rationale: "B-Decide"
      })
    ]);
    const body = cli([
      "pr-body",
      "--run-dir",
      dir,
      "--summary",
      "Fixes the login timeout."
    ]).stdout;
    assert.match(
      body,
      /^## Summary\n\nFixes the login timeout\.\n\n## Decisions\n\n- D001 \(medium\): Use a session cookie/
    );
    assert.match(body, /Generated with \[Claude Code\]/);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        pr: { attribution: false, body_sections: ["decisions"] }
      })
    );
    const out = cli([
      "pr-body",
      "--run-dir",
      dir,
      "--summary",
      "x",
      "--out",
      join(dir, "pr-body.md")
    ]).json();
    assert.equal(out.body_from_run, true);
    const written = readFileSync(join(dir, "pr-body.md"), "utf8");
    assert.equal(
      written,
      "## Decisions\n\n- D001 (medium): Use a session cookie\n"
    );
  });
});

describe("index", () => {
  function seed() {
    const runs = join(root, "runs");
    const make = (name, run, children = {}) => {
      const dir = join(runs, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "run.json"),
        JSON.stringify({
          id: name,
          type: "skill",
          started_at: NOW,
          ...run
        })
      );
      writeFileSync(join(dir, "summary.md"), "not read by index");
      writeFileSync(join(dir, "decisions.jsonl"), "not json");
      for (const [child, childRun] of Object.entries(children)) {
        const cdir = join(dir, "tasks", child);
        mkdirSync(cdir, { recursive: true });
        writeFileSync(
          join(cdir, "run.json"),
          JSON.stringify({
            id: child,
            type: "workflow",
            started_at: NOW,
            ...childRun
          })
        );
      }
    };
    make("2026-11-01-alpha", {
      status: "merged",
      repo: "acme/web",
      max_risk: "low"
    });
    make("2026-11-05-beta", {
      status: "halted",
      repo: "acme/api",
      max_risk: "high"
    });
    make(
      "2026-11-09-epic",
      { type: "overseer", status: "running", repo: null, max_risk: "medium" },
      { "T01-child": { status: "done", repo: "acme/web", max_risk: "medium" } }
    );
    mkdirSync(join(runs, "not-a-run"), { recursive: true });
    mkdirSync(join(runs, "2026-11-10-empty"), { recursive: true });
    return runs;
  }

  test("filters by date range from directory names", () => {
    const runs = seed();
    const ids = (out) => out.runs.map((r) => r.id);
    assert.deepEqual(ids(indexRuns([runs])), [
      "2026-11-01-alpha",
      "2026-11-05-beta",
      "2026-11-09-epic",
      "T01-child"
    ]);
    assert.deepEqual(
      ids(indexRuns([runs], { since: "2026-11-02", until: "2026-11-05" })),
      ["2026-11-05-beta"]
    );
  });

  test("filters by repo, status and risk", () => {
    const runs = seed();
    const ids = (filters) => indexRuns([runs], filters).runs.map((r) => r.id);
    assert.deepEqual(ids({ repo: "web" }), ["2026-11-01-alpha", "T01-child"]);
    assert.deepEqual(ids({ repo: "acme/api" }), ["2026-11-05-beta"]);
    assert.deepEqual(ids({ status: "merged,done" }), [
      "2026-11-01-alpha",
      "T01-child"
    ]);
    assert.deepEqual(ids({ risk: "medium" }), [
      "2026-11-05-beta",
      "2026-11-09-epic",
      "T01-child"
    ]);
    assert.deepEqual(ids({ risk: "high" }), ["2026-11-05-beta"]);
    const child = indexRuns([runs], { status: "done" }).runs[0];
    assert.equal(child.parent, "2026-11-09-epic");
    assert.equal(child.date, "2026-11-09");
  });

  test("reads no file other than run.json, and skips out-of-range runs unread", () => {
    const runs = seed();
    const read = [];
    const fs = {
      existsSync,
      readdirSync,
      statSync,
      readFileSync: (path, enc) => {
        read.push(path);
        return readFileSync(path, enc);
      }
    };
    indexRuns(
      [runs],
      { since: "2026-11-05", status: "halted", repo: "api", risk: "high" },
      fs
    );
    assert.ok(read.length > 0);
    for (const path of read) assert.match(path, /run\.json$/);
    assert.ok(!read.some((p) => p.includes("alpha")));
  });

  test("CLI defaults to recap.roots and runs.root, and supports --last", () => {
    const runs = seed();
    const other = join(root, "other");
    mkdirSync(join(other, "2026-11-08-gamma"), { recursive: true });
    writeFileSync(
      join(other, "2026-11-08-gamma", "run.json"),
      JSON.stringify({
        id: "2026-11-08-gamma",
        type: "skill",
        status: "done",
        started_at: NOW
      })
    );
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ runs: { root: runs }, recap: { roots: [other] } })
    );
    const out = cli(["index", "--last", "3d"]);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(
      out.json().runs.map((r) => r.id),
      ["2026-11-08-gamma", "2026-11-09-epic", "T01-child"]
    );
    assert.equal(cli(["index", "--root", runs, "--risk", "extreme"]).code, 2);
  });
});

describe("check", () => {
  const decision = {
    phase: "build",
    source: "agent",
    risk: "low",
    decision: "Keep the retry helper",
    rationale: "A-Fix"
  };
  const summaryText = (frontmatter) =>
    `---\n${frontmatter}\n---\n\n# Fix login timeout\n\n## Outcome\n\nMerged.\n`;
  const SUMMARY = [
    "task: 2026-11-10-fix-login-timeout",
    'title: "Fix login timeout"',
    "workflow: esp-ship",
    "status: merged",
    "pr: https://github.com/e-stpierre/skills/pull/12",
    "max_risk: low",
    "decisions: 4",
    "critical_findings: 0",
    "duration_minutes: 38"
  ];

  test("infers the kind from the file name", () => {
    const dir = createRun();
    cli(["decision", "--run-dir", dir, "--json", JSON.stringify(decision)]);
    for (const [file, kind] of [
      ["run.json", "run"],
      ["decisions.jsonl", "decision"]
    ]) {
      const out = cli(["check", join(dir, file)]);
      assert.equal(out.code, 0, out.stdout);
      assert.equal(out.json().valid, true);
      assert.equal(out.json().kind, kind);
    }
    const summary = join(dir, "summary.md");
    writeFileSync(summary, summaryText(SUMMARY.join("\n")));
    const out = cli(["check", summary]);
    assert.equal(out.code, 0, out.stdout);
    assert.equal(out.json().kind, "summary");
  });

  test("reports a summary missing its status, and a missing frontmatter", () => {
    const dir = createRun();
    const summary = join(dir, "summary.md");
    writeFileSync(
      summary,
      summaryText(SUMMARY.filter((l) => !l.startsWith("status:")).join("\n"))
    );
    const out = cli(["check", summary]);
    assert.equal(out.code, 1);
    assert.deepEqual(out.json().errors, [
      { path: "status", message: "is required" }
    ]);
    writeFileSync(summary, "# No frontmatter\n");
    assert.deepEqual(cli(["check", summary]).json().errors, [
      { path: "(frontmatter)", message: "is missing" }
    ]);
  });

  test("reports bad run.json fields and accepts unknown ones", () => {
    const dir = createRun();
    const path = join(dir, "run.json");
    const run = readJson(path);
    writeFileSync(path, JSON.stringify({ ...run, extra: true }));
    assert.equal(cli(["check", path]).code, 0);
    writeFileSync(
      path,
      JSON.stringify({ ...run, status: "finished", max_risk: "extreme" })
    );
    const out = cli(["check", path]);
    assert.equal(out.code, 1);
    assert.deepEqual(
      out.json().errors.map((e) => e.path),
      ["status", "max_risk"]
    );
  });

  test("reports invalid lines and blank lines inside a jsonl file", () => {
    const dir = createRun();
    cli(["decision", "--run-dir", dir, "--json", JSON.stringify(decision)]);
    const path = join(dir, "decisions.jsonl");
    const { rationale, ...broken } = { ...decision, id: "D002", at: NOW };
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n${JSON.stringify(broken)}\n\n`
    );
    const out = cli(["check", path]);
    assert.equal(out.code, 1);
    const errors = out.json().errors;
    assert.deepEqual(errors[0], {
      line: 2,
      path: "(root)",
      message: "blank line inside a jsonl file"
    });
    assert.equal(errors[1].line, 3);
    assert.equal(errors[1].path, "rationale");
    const bare = join(root, "x.json");
    writeFileSync(bare, "{}");
    assert.equal(cli(["check", bare]).code, 2);
    assert.equal(cli(["check", bare, "--kind", "run"]).code, 1);
    assert.equal(cli(["check", bare, "--kind", "schema"]).code, 2);
  });
});
