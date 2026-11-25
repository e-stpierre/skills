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
import { parseWorktrees } from "../housekeep.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "housekeep.mjs");
const PR = "https://github.com/o/r/pull/7";

let tmp;
let home;
let origin;
let repo;
let other;
let root;
let fakeGh;
let prsFile;
let ghLog;

const IDENTITY = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com"
};

function housekeep(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...IDENTITY,
      ESP_SKILLS_HOME: home,
      ESP_GH_CMD: JSON.stringify([process.execPath, fakeGh])
    }
  });
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json: () => JSON.parse(r.stdout)
  };
}

/** Run housekeeping in the working clone; expect exit 0 and return the JSON. */
function runIn(...args) {
  const r = housekeep("run", "--repo-dir", repo, "--base", "main", ...args);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return r.json();
}

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
const gitOk = (...args) =>
  spawnSync("git", args, { cwd: repo, encoding: "utf8" }).status === 0;

function commitIn(cwd, file, text, message) {
  writeFileSync(join(cwd, file), text);
  gitIn(cwd, "add", file);
  gitIn(cwd, "commit", "-qm", message);
  return gitIn(cwd, "rev-parse", "HEAD");
}

/** The upstream clone pushes a new commit to origin/main. */
function moveOriginMain(file = "upstream.txt", text = "upstream\n") {
  if (!existsSync(other)) gitIn(tmp, "clone", "-q", origin, other);
  else gitIn(other, "pull", "-q", "origin", "main");
  commitIn(other, file, text, `upstream change to ${file}`);
  gitIn(other, "push", "-q", "origin", "main");
  return gitIn(other, "rev-parse", "HEAD");
}

/** A task branch with one commit, then the working clone back on main. */
function taskBranch(name, file = `${name.replace(/\W/g, "-")}.txt`) {
  git("switch", "-q", "-c", name, "main");
  const sha = commitIn(repo, file, `${name}\n`, `work on ${name}`);
  git("switch", "-q", "main");
  return sha;
}

/** Squash-merge a branch's change on origin/main, as the hosting service would. */
function squashMerge(file, text) {
  return moveOriginMain(file, text);
}

function setPr(view) {
  writeFileSync(prsFile, JSON.stringify(view));
}

const ghCalls = () =>
  existsSync(ghLog)
    ? readFileSync(ghLog, "utf8").split("\n").filter(Boolean)
    : [];

const branches = () =>
  git("for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split(/\r?\n/)
    .filter(Boolean);
const results = (out) => out.steps.map((s) => `${s.step}:${s.result}`);
const stepOf = (out, name) => out.steps.find((s) => s.step === name);

/** Everything a dry run or a skipped run must leave unchanged. */
function snapshot() {
  return {
    refs: git("for-each-ref", "--format=%(refname) %(objectname)"),
    head: git("symbolic-ref", "-q", "HEAD"),
    status: git("status", "--porcelain"),
    worktrees: git("worktree", "list", "--porcelain")
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "esp-housekeep-"));
  home = join(tmp, "home");
  origin = join(tmp, "origin.git");
  repo = join(tmp, "repo");
  other = join(tmp, "other");
  root = join(tmp, "worktrees");
  mkdirSync(home);
  mkdirSync(repo);
  mkdirSync(root);
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ version: 1, worktrees: { root } })
  );
  prsFile = join(tmp, "prs.json");
  ghLog = join(tmp, "gh.log");
  fakeGh = join(tmp, "fake-gh.mjs");
  writeFileSync(
    fakeGh,
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghLog)}, args.join(" ") + "\\n");
if (args[0] !== "pr" || args[1] !== "view") process.exit(3);
const file = ${JSON.stringify(prsFile)};
if (!existsSync(file)) { console.error("no pull request"); process.exit(1); }
console.log(readFileSync(file, "utf8"));
`
  );
  gitIn(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git("init", "-q", "-b", "main");
  commitIn(repo, "a.txt", "a\n", "init");
  git("remote", "add", "origin", origin);
  git("push", "-q", "-u", "origin", "main");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("parseWorktrees", () => {
  test("reads paths and branches, the main worktree first", () => {
    const list = parseWorktrees(
      "worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/one\nHEAD def\nbranch refs/heads/feature/x\n\nworktree /w/two\nHEAD 123\ndetached\n"
    );
    assert.deepEqual(
      list.map((w) => [w.path, w.branch, w.main]),
      [
        ["/r", "main", true],
        ["/w/one", "feature/x", false],
        ["/w/two", null, false]
      ]
    );
  });
});

describe("usage", () => {
  test("missing --base is a usage error", () => {
    const r = housekeep("run", "--repo-dir", repo);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--base is required/);
  });

  test("--branch needs --pr", () => {
    const r = housekeep(
      "run",
      "--repo-dir",
      repo,
      "--base",
      "main",
      "--branch",
      "feature/a"
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--branch and --pr go together/);
  });

  test("an unknown command is a usage error", () => {
    assert.equal(housekeep("tidy").code, 2);
  });
});

describe("dirty checkout", () => {
  test("is reported and left unchanged", () => {
    taskBranch("feature/a", "a2.txt");
    setPr({
      state: "MERGED",
      headRefName: "feature/a",
      headRefOid: git("rev-parse", "feature/a")
    });
    moveOriginMain();
    git("switch", "-q", "feature/a");
    writeFileSync(join(repo, "a.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    const before = snapshot();
    const out = runIn("--branch", "feature/a", "--pr", PR, "--rebase", "x");
    assert.equal(out.status, "skipped");
    assert.equal(out.reason, "dirty");
    assert.deepEqual(out.files.sort(), [" M a.txt", "?? new.txt"]);
    assert.deepEqual(results(out), ["clean:skipped"]);
    assert.deepEqual(snapshot(), before);
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "edited\n");
    assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "untracked\n");
    assert.deepEqual(ghCalls(), []);
  });
});

describe("base", () => {
  test("is checked out and fast-forwarded to origin", () => {
    taskBranch("feature/a");
    git("switch", "-q", "feature/a");
    const upstream = moveOriginMain();
    const out = runIn();
    assert.equal(out.status, "done");
    assert.deepEqual(results(out), ["base:fast-forwarded"]);
    assert.equal(git("branch", "--show-current"), "main");
    assert.equal(git("rev-parse", "main"), upstream);
    // A second run has nothing to do.
    assert.deepEqual(results(runIn()), ["base:up-to-date"]);
  });

  test("with local commits is reported, not forced", () => {
    const local = commitIn(repo, "local.txt", "local\n", "local change");
    moveOriginMain();
    const out = runIn();
    assert.equal(out.status, "partial");
    assert.deepEqual(results(out), ["base:diverged"]);
    assert.equal(git("rev-parse", "main"), local);
  });
});

describe("task branch", () => {
  test("a squash-merged branch is deleted once gh reports it merged", () => {
    taskBranch("feature/a", "feat.txt");
    squashMerge("feat.txt", "feature/a\n");
    git("fetch", "-q", "origin", "main");
    // Squash merges are invisible to git branch --merged.
    assert.doesNotMatch(git("branch", "--merged", "origin/main"), /feature\/a/);
    setPr({
      state: "MERGED",
      headRefName: "feature/a",
      headRefOid: git("rev-parse", "feature/a")
    });
    const out = runIn("--branch", "feature/a", "--pr", PR);
    assert.equal(out.status, "done");
    assert.deepEqual(results(out), ["base:fast-forwarded", "branch:deleted"]);
    assert.deepEqual(branches(), ["main"]);
    assert.deepEqual(ghCalls(), [
      `pr view ${PR} --json state,headRefName,headRefOid`
    ]);
  });

  for (const state of ["OPEN", "CLOSED"]) {
    test(`an ${state} pull request keeps the branch`, () => {
      const sha = taskBranch("feature/a");
      setPr({ state, headRefName: "feature/a" });
      const out = runIn("--branch", "feature/a", "--pr", PR);
      assert.equal(out.status, "partial");
      assert.equal(stepOf(out, "branch").result, "kept");
      assert.match(stepOf(out, "branch").detail, new RegExp(state));
      assert.equal(git("rev-parse", "feature/a"), sha);
    });
  }

  test("a branch with local commits after the pull request head is kept", () => {
    const pushed = taskBranch("feature/a", "feat.txt");
    git("switch", "-q", "feature/a");
    const local = commitIn(repo, "later.txt", "later\n", "local only");
    git("switch", "-q", "main");
    setPr({ state: "MERGED", headRefName: "feature/a", headRefOid: pushed });
    const out = runIn("--branch", "feature/a", "--pr", PR);
    assert.equal(out.status, "partial");
    assert.equal(stepOf(out, "branch").result, "kept");
    assert.match(
      stepOf(out, "branch").detail,
      /local commits not in pull request/
    );
    assert.equal(git("rev-parse", "feature/a"), local);
  });

  test("a merged pull request with another head keeps the branch", () => {
    taskBranch("feature/a");
    setPr({ state: "MERGED", headRefName: "feature/b" });
    const out = runIn("--branch", "feature/a", "--pr", PR);
    assert.equal(stepOf(out, "branch").result, "kept");
    assert.match(stepOf(out, "branch").detail, /feature\/b/);
    assert.ok(branches().includes("feature/a"));
  });

  test("a gh failure keeps the branch", () => {
    taskBranch("feature/a");
    const out = runIn("--branch", "feature/a", "--pr", PR);
    assert.equal(stepOf(out, "branch").result, "kept");
    assert.match(stepOf(out, "branch").detail, /gh pr view failed/);
    assert.ok(branches().includes("feature/a"));
  });

  test("the base branch is never deleted", () => {
    setPr({ state: "MERGED", headRefName: "main" });
    const out = runIn("--branch", "main", "--pr", PR);
    assert.equal(stepOf(out, "branch").result, "kept");
    assert.ok(branches().includes("main"));
    assert.deepEqual(ghCalls(), []);
  });

  test("a branch checked out in another worktree is kept", () => {
    taskBranch("feature/a");
    const elsewhere = join(tmp, "elsewhere");
    git("worktree", "add", "-q", elsewhere, "feature/a");
    setPr({
      state: "MERGED",
      headRefName: "feature/a",
      headRefOid: git("rev-parse", "feature/a")
    });
    const out = runIn("--branch", "feature/a", "--pr", PR);
    assert.equal(out.status, "partial");
    assert.equal(stepOf(out, "branch").result, "kept");
    assert.match(stepOf(out, "branch").detail, /another worktree/);
    assert.ok(branches().includes("feature/a"));
  });
});

describe("worktrees", () => {
  test("a run worktree is removed, then its merged branch deleted", () => {
    taskBranch("feature/a");
    const wt = join(root, "run-1");
    git("worktree", "add", "-q", wt, "feature/a");
    setPr({
      state: "MERGED",
      headRefName: "feature/a",
      headRefOid: git("rev-parse", "feature/a")
    });
    const out = runIn("--worktree", wt, "--branch", "feature/a", "--pr", PR);
    assert.equal(out.status, "done");
    assert.deepEqual(results(out), [
      "base:up-to-date",
      "worktree:removed",
      "branch:deleted"
    ]);
    assert.equal(existsSync(wt), false);
    assert.deepEqual(branches(), ["main"]);
  });

  test("a foreign worktree is kept", () => {
    taskBranch("feature/a");
    const foreign = join(tmp, "foreign");
    git("worktree", "add", "-q", foreign, "feature/a");
    const out = runIn("--worktree", foreign);
    assert.equal(out.status, "partial");
    assert.equal(stepOf(out, "worktree").result, "kept");
    assert.match(stepOf(out, "worktree").detail, /outside worktrees.root/);
    assert.ok(existsSync(foreign));
  });

  test("a directory that is not a worktree, and the main one, are kept", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const out = runIn("--worktree", plain, "--worktree", repo);
    assert.deepEqual(
      out.steps.filter((s) => s.step === "worktree").map((s) => s.result),
      ["kept", "kept"]
    );
    assert.match(out.steps[1].detail, /not a worktree/);
    assert.match(out.steps[2].detail, /main worktree/);
    assert.ok(existsSync(plain));
  });

  test("a dirty run worktree is kept (no --force)", () => {
    taskBranch("feature/a");
    const wt = join(root, "run-1");
    git("worktree", "add", "-q", wt, "feature/a");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    const out = runIn("--worktree", wt);
    assert.equal(stepOf(out, "worktree").result, "kept");
    assert.ok(existsSync(join(wt, "wip.txt")));
  });
});

describe("rebase", () => {
  test("a later branch is rebased onto the new base", () => {
    const before = taskBranch("feature/b", "b.txt");
    const upstream = moveOriginMain();
    const out = runIn("--rebase", "feature/b");
    assert.equal(out.status, "done");
    assert.deepEqual(results(out), ["base:fast-forwarded", "rebase:rebased"]);
    assert.notEqual(git("rev-parse", "feature/b"), before);
    assert.equal(git("rev-parse", "feature/b~1"), upstream);
    assert.equal(git("branch", "--show-current"), "main");
  });

  test("a conflicting rebase is aborted and the branch left as it was", () => {
    const before = taskBranch("feature/c", "upstream.txt");
    moveOriginMain("upstream.txt", "different\n");
    const out = runIn("--rebase", "feature/c");
    assert.equal(out.status, "partial");
    assert.deepEqual(results(out), ["base:fast-forwarded", "rebase:conflict"]);
    assert.equal(git("rev-parse", "feature/c"), before);
    assert.equal(git("branch", "--show-current"), "main");
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(gitOk("rev-parse", "--verify", "-q", "REBASE_HEAD"), false);
  });

  test("a branch already on the base is up to date", () => {
    taskBranch("feature/b");
    const out = runIn("--rebase", "feature/b");
    assert.equal(stepOf(out, "rebase").result, "up-to-date");
  });
});

describe("dry run", () => {
  test("lists the planned steps and changes nothing", () => {
    taskBranch("feature/a", "feat.txt");
    taskBranch("feature/b", "b.txt");
    const wt = join(root, "run-1");
    git("worktree", "add", "-q", wt, "feature/a");
    squashMerge("feat.txt", "feature/a\n");
    git("fetch", "-q", "origin", "main");
    moveOriginMain();
    setPr({
      state: "MERGED",
      headRefName: "feature/a",
      headRefOid: git("rev-parse", "feature/a")
    });
    const before = snapshot();
    const out = runIn(
      "--dry-run",
      "--worktree",
      wt,
      "--branch",
      "feature/a",
      "--pr",
      PR,
      "--rebase",
      "feature/b"
    );
    assert.equal(out.dry_run, true);
    assert.deepEqual(results(out), [
      "base:planned",
      "worktree:planned",
      "branch:planned",
      "rebase:planned"
    ]);
    assert.match(
      stepOf(out, "base").detail,
      /git merge --ff-only origin\/main/
    );
    assert.match(stepOf(out, "rebase").detail, /git rebase origin\/main/);
    assert.deepEqual(snapshot(), before);
    assert.ok(existsSync(wt));
  });
});
