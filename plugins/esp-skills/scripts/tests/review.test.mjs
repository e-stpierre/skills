import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
  buildReport,
  classifyTarget,
  cmdParse,
  cmdTarget,
  dedupeFindings,
  diffFiles,
  nextRound,
  parseLocation,
  parseReview,
  renderReview,
  ReviewError,
  sameLocation
} from "../review.mjs";
import { cmdReview } from "../codex.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, "..", "review.mjs");

const REVIEW_MD = `Status: done

### Review: abc1234..def5678

Dimensions: correctness, security, tests. Candidates: 6, verified: 3, rejected: 3.

#### F1 - medium - tests - A

\`src/math.js:10\`: \`divide\` has no test for a zero divisor.

- Evidence: \`test/math.test.js\` only covers positive numbers
- Fix: add a test that expects \`divide(1, 0)\` to throw

#### F2 - high - correctness - A-Fix

\`src/math.js:4-6\`: \`sum\` skips the last element (off-by-one).

- Evidence: the loop runs while \`i < xs.length - 1\`
- Fix: loop while \`i < xs.length\`

#### F3 - low - simplification - B-Decide

\`src/math.js:20\`: \`clamp\` re-implements \`Math.min(Math.max())\`.

- Options: inline \`Math.min(Math.max())\`; keep the helper and reuse it in \`scale\`
- Recommended: inline it

#### Rejected Candidates

- \`src/math.js:12\` missing null check: callers validate input in \`src/cli.js:8\`
- \`src/math.js:30\` unused export: imported by \`src/report.js:2\`
- \`src/math.js:40\` slow loop: runs once per process

Discovered: debt - Legacy rounding helper - src/round.js:1
`;

function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

describe("classifyTarget", () => {
  test("recognizes every target form", () => {
    assert.deepEqual(classifyTarget(""), { kind: "local" });
    assert.deepEqual(classifyTarget(undefined), { kind: "local" });
    assert.deepEqual(classifyTarget("staged"), { kind: "staged" });
    assert.deepEqual(classifyTarget("UNSTAGED"), { kind: "unstaged" });
    assert.equal(classifyTarget("PR 123").number, 123);
    assert.equal(classifyTarget("pr #7").number, 7);
    assert.equal(classifyTarget("#42").kind, "pr");
    const url = classifyTarget("https://github.com/o/r/pull/12");
    assert.equal(url.kind, "pr");
    assert.equal(url.number, 12);
    assert.equal(url.url, "https://github.com/o/r/pull/12");
    assert.deepEqual(classifyTarget("main..HEAD"), {
      kind: "range",
      base: "main",
      head: "HEAD",
      dots: ".."
    });
    assert.equal(classifyTarget("origin/main...feature").dots, "...");
    assert.deepEqual(classifyTarget("origin/main"), {
      kind: "ref",
      ref: "origin/main"
    });
  });

  test("rejects free text", () => {
    assert.throws(
      () => classifyTarget("review my code"),
      (err) => err instanceof ReviewError && err.exitCode === 2
    );
  });
});

describe("diffFiles", () => {
  test("lists changed files once, in order", () => {
    const diff =
      "diff --git a/src/a.js b/src/a.js\n+x\ndiff --git a/old.js b/new.js\n-y\ndiff --git a/src/a.js b/src/a.js\n";
    assert.deepEqual(diffFiles(diff), ["src/a.js", "new.js"]);
  });
});

describe("target", () => {
  let repo;
  let runDir;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "esp-review-repo-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "a.js"), "export const a = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    runDir = mkdtempSync(join(tmpdir(), "esp-review-run-"));
    writeFileSync(join(runDir, "run.json"), "{}\n");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  });

  test("local changes include unstaged edits and untracked files", () => {
    writeFileSync(join(repo, "a.js"), "export const a = 2;\n");
    writeFileSync(join(repo, "b.js"), "export const b = 1;\n");
    const out = cmdTarget("", { "project-dir": repo, "run-dir": runDir });
    assert.equal(out.kind, "local");
    assert.equal(out.head, "working-tree");
    assert.deepEqual(out.files, ["a.js", "b.js"]);
    assert.deepEqual(out.untracked, ["b.js"]);
    assert.equal(out.empty, false);
    assert.equal(out.step, "review-1");
    assert.equal(out.diff_path, join(runDir, "review-1.diff"));
    assert.match(readFileSync(out.diff_path, "utf8"), /\+export const a = 2;/);
  });

  test("a clean tree reviews the branch against the default branch", () => {
    git(repo, "checkout", "-q", "-b", "feature/x");
    writeFileSync(join(repo, "c.js"), "export const c = 3;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "add c");
    const out = cmdTarget("", { "project-dir": repo, "run-dir": runDir });
    assert.equal(out.kind, "branch");
    assert.equal(out.base_ref, "main");
    assert.equal(out.base, git(repo, "rev-parse", "main"));
    assert.equal(out.head, git(repo, "rev-parse", "HEAD"));
    assert.deepEqual(out.files, ["c.js"]);
  });

  test("staged, ref and range targets", () => {
    git(repo, "checkout", "-q", "-b", "feature/y");
    writeFileSync(join(repo, "d.js"), "export const d = 4;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "add d");
    writeFileSync(join(repo, "e.js"), "export const e = 5;\n");
    git(repo, "add", "e.js");
    assert.deepEqual(
      cmdTarget("staged", { "project-dir": repo, "run-dir": runDir }).files,
      ["e.js"]
    );
    assert.deepEqual(
      cmdTarget("main", { "project-dir": repo, "run-dir": runDir }).files,
      ["d.js"]
    );
    assert.deepEqual(
      cmdTarget("main..HEAD", { "project-dir": repo, "run-dir": runDir }).files,
      ["d.js"]
    );
    assert.throws(
      () => cmdTarget("nope", { "project-dir": repo }),
      (err) => err.exitCode === 2
    );
  });

  test("an empty diff is reported as empty", () => {
    const out = cmdTarget("", { "project-dir": repo, "run-dir": runDir });
    assert.equal(out.empty, true);
    assert.deepEqual(out.files, []);
  });

  test("rounds increase with each saved review", () => {
    assert.equal(nextRound(runDir), 1);
    writeFileSync(join(runDir, "review-1.md"), "x");
    writeFileSync(join(runDir, "review-3.md"), "x");
    writeFileSync(join(runDir, "review-4.diff"), "x");
    assert.equal(nextRound(runDir), 4);
    writeFileSync(join(repo, "a.js"), "export const a = 9;\n");
    const out = cmdTarget("", { "project-dir": repo, "run-dir": runDir });
    assert.equal(out.step, "review-4");
    assert.equal(out.review_path, join(runDir, "review-4.md"));
  });

  test("without a run dir the diff goes to a temp directory", () => {
    writeFileSync(join(repo, "a.js"), "export const a = 3;\n");
    const out = cmdTarget("", { "project-dir": repo });
    assert.equal(out.run_dir, null);
    assert.ok(existsSync(out.diff_path));
    assert.equal(dirname(out.review_path), dirname(out.diff_path));
    rmSync(dirname(out.diff_path), { recursive: true, force: true });
  });

  test("a run dir without run.json is refused", () => {
    rmSync(join(runDir, "run.json"));
    assert.throws(
      () => cmdTarget("", { "project-dir": repo, "run-dir": runDir }),
      /Not a run directory/
    );
  });

  test("pull requests come from gh", () => {
    const fake = join(runDir, "fake-gh.mjs");
    writeFileSync(
      fake,
      `const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ number: 12, title: "Add c", url: "https://github.com/o/r/pull/12", baseRefName: "main", headRefName: "feature/c", headRefOid: "${"b".repeat(40)}" }));
} else if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write("diff --git a/c.js b/c.js\\n+++ b/c.js\\n+export const c = 3;\\n");
} else process.exit(3);
`
    );
    const env = {
      ...process.env,
      ESP_GH_CMD: JSON.stringify([process.execPath, fake])
    };
    const out = cmdTarget(
      "PR 12",
      { "project-dir": repo, "run-dir": runDir },
      env
    );
    assert.equal(out.kind, "pr");
    assert.equal(out.pr.number, 12);
    assert.equal(out.base, "main");
    assert.equal(out.head, "b".repeat(40));
    assert.deepEqual(out.files, ["c.js"]);
    assert.deepEqual(out.stats, { files: 1, additions: 1, deletions: 0 });
  });
});

describe("parseReview", () => {
  test("parses findings, rejected candidates and the trailing JSON line", () => {
    const parsed = parseReview(REVIEW_MD);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.header.base, "abc1234");
    assert.equal(parsed.header.head, "def5678");
    assert.deepEqual(parsed.header.dimensions, [
      "correctness",
      "security",
      "tests"
    ]);
    assert.equal(parsed.header.rejected, 3);
    assert.equal(parsed.findings.length, 3);
    const [f1, f2, f3] = parsed.findings;
    assert.equal(f1.location, "src/math.js:10");
    assert.equal(f1.fix, "add a test that expects `divide(1, 0)` to throw");
    assert.equal(f2.class, "A", "A-Fix is normalized to A");
    assert.equal(f3.class, "B-Decide");
    assert.equal(f3.recommended, "inline it");
    assert.equal(parsed.rejected.length, 3);
    assert.equal(parsed.status, "done");
    assert.deepEqual(parsed.discovered, [
      {
        type: "debt",
        title: "Legacy rounding helper",
        evidence: "src/round.js:1"
      }
    ]);
  });

  test("still reads the discovered items of a trailing JSON line", () => {
    const legacy = REVIEW_MD.replace("Status: done\n\n", "").replace(
      "\nDiscovered: debt - Legacy rounding helper - src/round.js:1\n",
      '{"status":"done","discovered_items":[{"type":"bug","title":"Old"}]}\n'
    );
    const parsed = parseReview(legacy);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.status, null);
    assert.equal(parsed.findings.length, 3);
    assert.deepEqual(parsed.discovered, [{ type: "bug", title: "Old" }]);
  });

  test("an untyped Discovered line becomes an other item", () => {
    const parsed = parseReview(
      REVIEW_MD.replace(
        "debt - Legacy rounding helper - src/round.js:1",
        "flaky CI on Windows"
      )
    );
    assert.deepEqual(parsed.discovered, [
      { type: "other", title: "flaky CI on Windows" }
    ]);
  });

  test("accepts CRLF, a BOM and headings inside code fences", () => {
    const text = `${String.fromCharCode(0xfeff)}${REVIEW_MD.replace("- Fix: loop while", "```md\n#### F9 - bogus\n```\n- Fix: loop while")}`;
    const parsed = parseReview(text.replace(/\n/g, "\r\n"));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.findings.length, 3);
  });

  test("reports malformed findings", () => {
    const bad = `#### F1 - severe - style - A

no location here

#### F2 - high - correctness

\`a.js:1\`: missing class

- Fix: x

#### F2 - low - tests - B-Decide

\`a.js:2\`: duplicate id
`;
    const { errors } = parseReview(bad);
    assert.ok(errors.some((e) => /unknown severity "severe"/.test(e)));
    assert.ok(errors.some((e) => /unknown dimension "style"/.test(e)));
    assert.ok(errors.some((e) => /backticked location/.test(e)));
    assert.ok(errors.some((e) => /missing "- Fix:"/.test(e)));
    assert.ok(errors.some((e) => /heading must be/.test(e)));
    assert.ok(errors.some((e) => /B-Decide findings need/.test(e)));
    assert.ok(errors.some((e) => /duplicate finding ID F2/.test(e)));
  });

  test("no findings", () => {
    const parsed = parseReview(
      "### Review: a..b\n\nDimensions: correctness. Candidates: 1, verified: 0, rejected: 1.\n\nNo findings.\n\n#### Rejected Candidates\n\n- `a.js:1` fine\n"
    );
    const report = buildReport(parsed);
    assert.equal(report.findings.length, 0);
    assert.equal(report.outcome.summary, "No findings, 1 candidate rejected.");
    assert.equal(report.outcome.max_risk, "low");
  });

  test("a failed reviewer reply is a failed outcome, not a clean review", () => {
    const parsed = parseReview(
      "Status: failed\nSummary: The diff file could not be read.\n"
    );
    assert.deepEqual(parsed.errors, []);
    const report = buildReport(parsed);
    assert.equal(report.outcome.status, "failed");
    assert.equal(report.outcome.summary, "The diff file could not be read.");
    const again = buildReport(
      parseReview(renderReview(parsed, report.dropped))
    );
    assert.equal(again.outcome.status, "failed");
  });
});

describe("buildReport", () => {
  test("applies the minimum severity, sorts by severity and builds the outcome", () => {
    const report = buildReport(parseReview(REVIEW_MD), {
      minSeverity: "medium"
    });
    assert.deepEqual(
      report.findings.map((f) => f.id),
      ["F2", "F1"]
    );
    assert.deepEqual(report.dropped, ["F3"]);
    const { outcome: result } = report;
    assert.equal(result.status, "done");
    assert.equal(result.max_risk, "high");
    assert.equal(
      result.summary,
      "2 findings (1 high, 1 medium), 3 candidates rejected."
    );
    assert.deepEqual(result.outputs.by_class, {
      A: 2,
      "B-Decide": 0,
      "B-Scope": 0
    });
    assert.deepEqual(result.outputs.by_severity, {
      critical: 0,
      high: 1,
      medium: 1,
      low: 0
    });
    assert.equal(result.outputs.dropped, 1);
    assert.equal(result.outputs.verified, true);
    assert.equal(result.discovered_items[0].title, "Legacy rounding helper");
  });

  test("critical findings raise the risk to high and an unverified review is flagged", () => {
    const md = REVIEW_MD.replace(
      "#### F1 - medium - tests - A",
      "#### F1 - critical - security - A"
    );
    const report = buildReport(parseReview(md), {
      minSeverity: "critical",
      verified: false
    });
    assert.deepEqual(
      report.findings.map((f) => f.id),
      ["F1"]
    );
    assert.equal(report.outcome.max_risk, "high");
    assert.equal(report.outcome.outputs.verified, false);
  });

  test("rejects an unknown minimum severity", () => {
    assert.throws(
      () => buildReport(parseReview(REVIEW_MD), { minSeverity: "urgent" }),
      (err) => err.exitCode === 2
    );
  });
});

describe("renderReview and the parse command", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "esp-review-parse-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("renderReview drops filtered findings and the status line, and keeps discovered items", () => {
    const parsed = parseReview(REVIEW_MD);
    const md = renderReview(parsed, ["F3"]);
    assert.doesNotMatch(md, /#### F3/);
    assert.match(md, /#### F2/);
    assert.match(md, /#### Rejected Candidates/);
    assert.doesNotMatch(md, /^Status:/m);
    assert.match(md, /^### Review:/);
    assert.deepEqual(parseReview(md).discovered, parsed.discovered);
  });

  test("renderReview writes the items of a trailing JSON line as Discovered lines", () => {
    const legacy = REVIEW_MD.replace(
      "Discovered: debt - Legacy rounding helper - src/round.js:1",
      '{"status":"done","discovered_items":[{"type":"bug","title":"Old"}]}'
    );
    const md = renderReview(parseReview(legacy), []);
    assert.doesNotMatch(md, /"status"/);
    assert.match(md, /^Discovered: bug - Old$/m);
  });

  test("parse rewrites the review in place and writes the findings file", () => {
    const md = join(dir, "review-1.md");
    const json = join(dir, "review-1.json");
    writeFileSync(md, REVIEW_MD);
    const { output, exitCode = 0 } = cmdParse(md, {
      "min-severity": "medium",
      "md-out": md,
      out: json
    });
    assert.equal(exitCode, 0);
    assert.equal(output.outcome.outputs.review_path, md);
    assert.equal(output.outcome.outputs.findings_path, json);
    assert.doesNotMatch(readFileSync(md, "utf8"), /#### F3/);
    const saved = JSON.parse(readFileSync(json, "utf8"));
    assert.equal(saved.review_format, 1);
    assert.deepEqual(
      saved.findings.map((f) => f.id),
      ["F2", "F1"]
    );
    assert.equal(saved.rejected.length, 3);
  });

  test("the CLI prints the outcome and fails on a malformed review", () => {
    const md = join(dir, "review.md");
    writeFileSync(md, REVIEW_MD);
    const ok = spawnSync(
      process.execPath,
      [REVIEW, "parse", md, "--min-severity", "high"],
      {
        encoding: "utf8"
      }
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).outcome.outputs.findings, 1);
    writeFileSync(md, "#### F1 - nope - correctness - A\n");
    const bad = spawnSync(process.execPath, [REVIEW, "parse", md], {
      encoding: "utf8"
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /unknown severity/);
    const usage = spawnSync(process.execPath, [REVIEW, "parse"], {
      encoding: "utf8"
    });
    assert.equal(usage.status, 2);
  });
});

describe("Codex second opinion", () => {
  let dir;
  let repo;
  const FAKE = join(HERE, "helpers", "fake-codex.mjs");
  const CODEX_REPLY = {
    summary: "Two issues",
    findings: [
      {
        severity: "high",
        dimension: "correctness",
        class: "A",
        file: "src/math.js",
        line: 5,
        title: "Off-by-one in sum",
        evidence: "the loop stops one element early",
        fix: "loop to xs.length",
        options: null,
        recommended: null
      },
      {
        severity: "medium",
        dimension: "security",
        class: "A",
        file: "src/io.js",
        line: 3,
        title: "Path traversal in readUser",
        evidence: "the name is joined unchecked",
        fix: "reject names with a separator",
        options: null,
        recommended: null
      }
    ]
  };
  // The reviewer verified both Codex candidates: C1 repeats F2 at
  // src/math.js:4-6 and keeps its Source line; C2 is new.
  const MERGED_MD = REVIEW_MD.replace(
    "#### Rejected Candidates",
    `#### F4 - high - correctness - A

\`src/math.js:4\`: Off-by-one in sum.

- Evidence: the loop stops one element early
- Fix: loop to xs.length
- Source: codex

#### F5 - medium - security - A

\`src/io.js:3\`: Path traversal in readUser.

- Evidence: the name is joined unchecked
- Fix: reject names with a separator
- Source: codex

#### Rejected Candidates`
  );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "esp-review-codex-"));
    repo = join(dir, "repo");
    for (const args of [
      ["init", "-q", "-b", "main", repo],
      ["-C", repo, "config", "user.email", "t@example.com"],
      ["-C", repo, "config", "user.name", "T"]
    ])
      assert.equal(spawnSync("git", args).status, 0);
    writeFileSync(join(repo, "a.js"), "export const a = 1;\n");
    spawnSync("git", ["-C", repo, "add", "."]);
    spawnSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
    writeFileSync(join(repo, "a.js"), "export const a = 2;\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Run codex.mjs review on the fake Codex and save its JSON like the skill. */
  async function codexReview(exec) {
    const scenario = join(dir, "scenario.json");
    writeFileSync(scenario, JSON.stringify({ exec }));
    const env = {
      ...process.env,
      ESP_CODEX_CMD: JSON.stringify([process.execPath, FAKE]),
      ESP_FAKE_CODEX: scenario
    };
    const result = await cmdReview(
      "",
      { cwd: repo, out: join(dir, "review-1.codex.md") },
      env
    );
    const path = join(dir, "review-1.codex.json");
    writeFileSync(path, JSON.stringify(result));
    return { result, path };
  }

  test("locations match on the same file and start line", () => {
    assert.deepEqual(parseLocation("./src\\a.js:4-6"), {
      file: "src/a.js",
      start: 4,
      end: 6
    });
    assert.ok(sameLocation("src/a.js:4-6", "src/a.js:4"));
    assert.ok(sameLocation("./src/a.js:4", "src\\a.js:4-9"));
    assert.ok(!sameLocation("src/a.js:4-6", "src/a.js:5"));
    assert.ok(!sameLocation("src/a.js:10-120", "src/a.js:50"));
    assert.ok(!sameLocation("src/a.js", "src/a.js"));
    assert.ok(!sameLocation("src/a.js:4-6", "src/a.js:7"));
    assert.ok(!sameLocation("src/a.js:4", "src/b.js:4"));
    assert.ok(!sameLocation("src/a.js", "src/a.js:4"));
  });

  test("only second-opinion findings are dropped as duplicates", () => {
    const parsed = parseReview(MERGED_MD);
    assert.equal(parsed.findings.find((f) => f.id === "F4").source, "codex");
    assert.equal("source" in parsed.findings[0], false);
    const { kept, duplicates } = dedupeFindings(parsed.findings);
    assert.deepEqual(
      kept.map((f) => f.id),
      ["F1", "F2", "F3", "F5"]
    );
    assert.deepEqual(duplicates, [
      {
        id: "F4",
        of: "F2",
        source: "codex",
        location: "src/math.js:4",
        title: "Off-by-one in sum."
      }
    ]);
  });

  test("Codex findings are merged, tagged and deduplicated by file and start line", async () => {
    const { result, path } = await codexReview({
      last_message: JSON.stringify(CODEX_REPLY)
    });
    assert.equal(result.status, "done");
    assert.equal(result.findings.length, 2);
    const md = join(dir, "review-1.md");
    const json = join(dir, "review-1.json");
    writeFileSync(md, MERGED_MD);
    const { output } = cmdParse(md, {
      "min-severity": "medium",
      "md-out": md,
      out: json,
      codex: path
    });
    assert.deepEqual(
      output.findings.map((f) => [f.id, f.source ?? "claude"]),
      [
        ["F2", "claude"],
        ["F1", "claude"],
        ["F5", "codex"]
      ]
    );
    assert.deepEqual(
      output.duplicates.map((d) => [d.id, d.of]),
      [["F4", "F2"]]
    );
    assert.deepEqual(output.outcome.outputs.second_opinion, {
      tool: "codex",
      status: "done",
      summary: "Two issues",
      candidates: 2,
      kept: 1,
      duplicates: 1
    });
    assert.match(
      output.outcome.summary,
      /Codex second opinion: 1 kept, 1 duplicate\.$/
    );
    const rendered = readFileSync(md, "utf8");
    assert.doesNotMatch(rendered, /#### F4/);
    assert.match(rendered, /#### F5/);
    assert.match(
      rendered,
      /^- `src\/math\.js:4` Off-by-one in sum: duplicate of F2 \(codex\)$/m
    );
    const saved = JSON.parse(readFileSync(json, "utf8"));
    assert.equal(saved.second_opinion.kept, 1);
    assert.equal(saved.findings.find((f) => f.id === "F5").source, "codex");
    // Parsing the rewritten review again (esp-review step 9) is stable.
    const again = cmdParse(md, { "min-severity": "medium", codex: path });
    assert.deepEqual(
      again.output.findings.map((f) => f.id),
      ["F2", "F1", "F5"]
    );
    assert.deepEqual(again.output.duplicates, []);
  });

  test("a Codex failure degrades to a Claude-only review", async () => {
    const { result, path } = await codexReview({
      exit_code: 1,
      stderr: "error: not logged in"
    });
    assert.equal(result.status, "failed");
    const md = join(dir, "review-1.md");
    writeFileSync(md, REVIEW_MD);
    const { output } = cmdParse(md, { "min-severity": "medium", codex: path });
    assert.equal(output.outcome.status, "done");
    assert.equal(output.findings.length, 2);
    assert.equal(output.outcome.outputs.second_opinion.status, "failed");
    assert.equal(output.outcome.outputs.second_opinion.candidates, 0);
    assert.match(
      output.outcome.summary,
      /Codex second opinion failed \(.+\): Claude-only review\.$/
    );
    const missing = cmdParse(md, { codex: join(dir, "none.json") });
    assert.equal(
      missing.output.outcome.outputs.second_opinion.status,
      "failed"
    );
  });

  test("without --codex the outcome is unchanged", () => {
    const md = join(dir, "review-1.md");
    writeFileSync(md, REVIEW_MD);
    const { output } = cmdParse(md, { "min-severity": "medium" });
    assert.equal("second_opinion" in output.outcome.outputs, false);
    assert.equal("duplicates" in output.outcome.outputs, false);
    assert.equal(
      output.outcome.summary,
      "2 findings (1 high, 1 medium), 3 candidates rejected."
    );
    assert.ok(output.findings.every((f) => !("source" in f)));
  });
});
