#!/usr/bin/env node
// esp-skills git housekeeping for esp-orchestrate.
//
// After a pull request merges, tidies the local checkout of its repository:
// fast-forwards the base branch, deletes the merged local task branch, removes
// the worktrees the run created, and rebases the branches of later work onto
// the new base. Every step is guarded so that nothing unmerged or foreign is
// lost:
//
//   - A dirty checkout is reported and left untouched
//   - A non-fast-forward base is reported, never forced
//   - A branch is deleted only when `gh pr view` reports its pull request
//     merged with a matching head (squash-safe: never `git branch --merged`),
//     never the base branch, never a branch checked out in another worktree
//   - A worktree is removed only when it is a linked worktree of this
//     repository under worktrees.root, without --force
//   - A conflicting rebase is aborted, and the base branch checked out again
//   - Nothing is ever pushed
//
// Every command prints JSON to stdout. Exit codes: 0 ok (done, skipped or
// partial), 1 failed, 2 usage.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, expandHome, loadConfig } from "./config.mjs";

export class HousekeepError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "HousekeepError";
    this.exitCode = exitCode;
  }
}

/** Step results that leave something in place: the run is `partial`. */
const PARTIAL_RESULTS = new Set(["kept", "conflict", "diverged"]);
const DEFAULT_WORKTREES_ROOT = "~/.esp-skills/worktrees";

// ---------------------------------------------------------------------------
// git and gh
// ---------------------------------------------------------------------------

/** Run git in `cwd`; never throws on a non-zero exit. */
export function git(cwd, args) {
  const res = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.error)
    throw new HousekeepError(`git could not run: ${res.error.message}`);
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trimEnd(),
    stderr: (res.stderr ?? "").trim()
  };
}

const gitError = (res) => res.stderr || res.stdout || "git failed";

/** A `gh pr view` reader. `ESP_GH_CMD` (a JSON array) replaces `gh`, for tests. */
export function ghPrView(pr, { cwd, env = process.env } = {}) {
  let prefix;
  try {
    prefix = env.ESP_GH_CMD ? JSON.parse(env.ESP_GH_CMD) : ["gh"];
  } catch {
    throw new HousekeepError("ESP_GH_CMD must be a JSON array", 2);
  }
  const res = spawnSync(
    prefix[0],
    [...prefix.slice(1), "pr", "view", pr, "--json", "state,headRefName"],
    { cwd, encoding: "utf8", windowsHide: true }
  );
  if (res.error) return { error: `gh could not run: ${res.error.message}` };
  if (res.status !== 0)
    return {
      error: `gh pr view failed: ${(res.stderr || res.stdout || "").trim()}`
    };
  try {
    return { view: JSON.parse(res.stdout) };
  } catch {
    return { error: "gh pr view printed invalid JSON" };
  }
}

// ---------------------------------------------------------------------------
// Paths and worktrees
// ---------------------------------------------------------------------------

/** A comparable form of a path: real, resolved, case-folded on Windows. */
export function canonical(path) {
  let full = resolve(path);
  try {
    if (existsSync(full)) full = realpathSync.native(full);
  } catch {
    // Keep the resolved path.
  }
  return process.platform === "win32" ? full.toLowerCase() : full;
}

export function isInside(child, parent) {
  const rel = relative(canonical(parent), canonical(child));
  return (
    rel !== "" &&
    !rel.startsWith("..") &&
    !rel.startsWith(sep) &&
    !/^[a-z]:/i.test(rel)
  );
}

/**
 * Parse `git worktree list --porcelain`: one entry per worktree, the main one
 * first, with its path, checked out branch (short name) and flags.
 */
export function parseWorktrees(text) {
  const entries = [];
  let current = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branch: null, bare: false };
      entries.push(current);
    } else if (!current) continue;
    else if (line.startsWith("branch "))
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare") current.bare = true;
    else if (line === "detached") current.detached = true;
  }
  return entries.map((entry, index) => ({ ...entry, main: index === 0 }));
}

function listWorktrees(repoDir) {
  const res = git(repoDir, ["worktree", "list", "--porcelain"]);
  if (!res.ok) throw new HousekeepError(gitError(res));
  return parseWorktrees(res.stdout);
}

const branchExists = (repoDir, branch) =>
  git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;

/**
 * The worktree, other than `repoDir`, where `branch` is checked out, or
 * null. `gone` holds the worktrees a dry run plans to remove.
 */
function otherCheckout(repoDir, branch, gone = new Set()) {
  const self = canonical(repoDir);
  return (
    listWorktrees(repoDir).find((w) => {
      const path = canonical(w.path);
      return w.branch === branch && path !== self && !gone.has(path);
    }) ?? null
  );
}

/** The `git status --porcelain` lines of a dirty checkout, else []. */
export function dirtyFiles(repoDir) {
  const res = git(repoDir, ["status", "--porcelain"]);
  if (!res.ok) throw new HousekeepError(gitError(res));
  return res.stdout === "" ? [] : res.stdout.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const step = (name, target, result, detail) => ({
  step: name,
  target,
  result,
  detail
});

/** Fetch the base, switch to it and fast-forward it to origin/<base>. */
function syncBase(ctx) {
  const { repoDir, base, dryRun } = ctx;
  if (dryRun)
    return step(
      "base",
      base,
      "planned",
      `git fetch origin ${base}; git switch ${base}; git merge --ff-only origin/${base}`
    );
  const fetch = git(repoDir, ["fetch", "origin", base]);
  if (!fetch.ok) return step("base", base, "failed", gitError(fetch));
  const remote = `origin/${base}`;
  const current = git(repoDir, ["branch", "--show-current"]).stdout;
  if (current !== base) {
    const sw = git(repoDir, ["switch", base]);
    if (!sw.ok) return step("base", base, "failed", gitError(sw));
  }
  const before = git(repoDir, ["rev-parse", "HEAD"]).stdout;
  const after = git(repoDir, ["rev-parse", remote]);
  if (!after.ok) return step("base", base, "failed", gitError(after));
  if (before === after.stdout)
    return step("base", base, "up-to-date", `at ${after.stdout.slice(0, 7)}`);
  const ancestor = (a, b) =>
    git(repoDir, ["merge-base", "--is-ancestor", a, b]).ok;
  if (ancestor(remote, "HEAD"))
    return step(
      "base",
      base,
      "up-to-date",
      `local ${base} is ahead of ${remote}`
    );
  if (!ancestor("HEAD", remote))
    return step(
      "base",
      base,
      "diverged",
      `local ${base} has commits not on ${remote}: not fast-forwarded`
    );
  const merge = git(repoDir, ["merge", "--ff-only", remote]);
  if (!merge.ok) return step("base", base, "failed", gitError(merge));
  return step(
    "base",
    base,
    "fast-forwarded",
    `${before.slice(0, 7)} -> ${after.stdout.slice(0, 7)}`
  );
}

/** Delete the merged local task branch, under every guard. */
function deleteBranch(ctx, branch, pr) {
  const { repoDir, base, dryRun, env } = ctx;
  if (branch === base)
    return step("branch", branch, "kept", "the base branch is never deleted");
  if (!branchExists(repoDir, branch))
    return step("branch", branch, "skipped", "no local branch");
  const { view, error } = ghPrView(pr, { cwd: repoDir, env });
  if (error) return step("branch", branch, "kept", error);
  if (view?.state !== "MERGED")
    return step(
      "branch",
      branch,
      "kept",
      `pull request ${pr} is ${view?.state ?? "unknown"}, not merged`
    );
  if (view.headRefName !== branch)
    return step(
      "branch",
      branch,
      "kept",
      `pull request head is ${view.headRefName}, not ${branch}`
    );
  const other = otherCheckout(repoDir, branch, ctx.planned);
  if (other)
    return step(
      "branch",
      branch,
      "kept",
      `checked out in another worktree: ${other.path}`
    );
  if (dryRun)
    return step("branch", branch, "planned", `git branch -D ${branch}`);
  const res = git(repoDir, ["branch", "-D", branch]);
  if (!res.ok) return step("branch", branch, "failed", gitError(res));
  return step("branch", branch, "deleted", `pull request ${pr} is merged`);
}

/** Remove one run worktree, under every guard. */
function removeWorktree(ctx, path) {
  const { repoDir, dryRun } = ctx;
  const target = resolve(expandHome(path));
  const wanted = canonical(target);
  const entry = listWorktrees(repoDir).find(
    (w) => canonical(w.path) === wanted
  );
  if (!entry)
    return step(
      "worktree",
      target,
      "kept",
      "not a worktree of this repository"
    );
  if (entry.main)
    return step(
      "worktree",
      target,
      "kept",
      "the main worktree is never removed"
    );
  const root = ctx.worktreesRoot();
  if (!isInside(target, root))
    return step("worktree", target, "kept", `outside worktrees.root (${root})`);
  if (dryRun) {
    ctx.planned.add(wanted);
    return step("worktree", target, "planned", `git worktree remove ${target}`);
  }
  const res = git(repoDir, ["worktree", "remove", target]);
  if (!res.ok) return step("worktree", target, "kept", gitError(res));
  return step("worktree", target, "removed", "linked run worktree removed");
}

/** Rebase one later branch onto origin/<base>; abort on a conflict. */
function rebaseBranch(ctx, branch) {
  const { repoDir, base, dryRun } = ctx;
  const remote = `origin/${base}`;
  if (branch === base)
    return step("rebase", branch, "skipped", "the base branch is not rebased");
  if (!branchExists(repoDir, branch))
    return step("rebase", branch, "skipped", "no local branch");
  const other = otherCheckout(repoDir, branch, ctx.planned);
  if (other)
    return step(
      "rebase",
      branch,
      "kept",
      `checked out in another worktree: ${other.path}`
    );
  if (git(repoDir, ["merge-base", "--is-ancestor", remote, branch]).ok)
    return step("rebase", branch, "up-to-date", `already on ${remote}`);
  if (dryRun)
    return step("rebase", branch, "planned", `git rebase ${remote} ${branch}`);
  const before = git(repoDir, ["rev-parse", branch]).stdout;
  const res = git(repoDir, ["rebase", remote, branch]);
  if (res.ok) {
    const back = git(repoDir, ["switch", base]);
    if (!back.ok) return step("rebase", branch, "failed", gitError(back));
    const after = git(repoDir, ["rev-parse", branch]).stdout;
    return step(
      "rebase",
      branch,
      "rebased",
      `${before.slice(0, 7)} -> ${after.slice(0, 7)} onto ${remote}`
    );
  }
  const abort = git(repoDir, ["rebase", "--abort"]);
  const back = git(repoDir, ["switch", base]);
  if (!abort.ok || !back.ok)
    return step(
      "rebase",
      branch,
      "failed",
      `rebase failed and could not be undone: ${gitError(abort.ok ? back : abort)}`
    );
  return step(
    "rebase",
    branch,
    "conflict",
    `rebase onto ${remote} conflicted and was aborted; ${branch} stays at ${before.slice(0, 7)}`
  );
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function overallStatus(steps) {
  if (steps.some((s) => s.result === "failed")) return "failed";
  if (steps.some((s) => PARTIAL_RESULTS.has(s.result))) return "partial";
  return "done";
}

function summarize(status, steps, dryRun) {
  const counts = {};
  for (const s of steps) counts[s.result] = (counts[s.result] ?? 0) + 1;
  const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}`);
  return `${dryRun ? "Dry run " : ""}${status}: ${parts.join(", ") || "nothing to do"}`;
}

/**
 * Run every housekeeping step in `repoDir`.
 * @returns {{ status: string, steps: object[] }}
 */
export function housekeep(options, env = process.env) {
  const repoDir = resolve(expandHome(String(options.repoDir)));
  const { base } = options;
  const dryRun = Boolean(options.dryRun);
  if (!existsSync(repoDir))
    throw new HousekeepError(`Repository not found: ${repoDir}`);
  if (!git(repoDir, ["rev-parse", "--git-dir"]).ok)
    throw new HousekeepError(`Not a git checkout: ${repoDir}`);
  const head = { repo_dir: repoDir, base, dry_run: dryRun };

  const files = dirtyFiles(repoDir);
  if (files.length > 0) {
    const steps = [
      step(
        "clean",
        repoDir,
        "skipped",
        `dirty checkout (${files.length} changed files): nothing changed`
      )
    ];
    return {
      status: "skipped",
      reason: "dirty",
      files,
      ...head,
      summary: `Skipped: the checkout at ${repoDir} has uncommitted changes`,
      steps
    };
  }

  let root = null;
  const ctx = {
    repoDir,
    base,
    dryRun,
    env,
    planned: new Set(),
    worktreesRoot() {
      if (root) return root;
      try {
        const { config } = loadConfig({ projectDir: repoDir, env });
        root = resolve(
          expandHome(String(config.worktrees?.root ?? DEFAULT_WORKTREES_ROOT))
        );
      } catch (err) {
        if (err instanceof ConfigError) throw new HousekeepError(err.message);
        throw err;
      }
      return root;
    }
  };

  const steps = [];
  const baseStep = syncBase(ctx);
  steps.push(baseStep);
  const baseOk = baseStep.result !== "failed";
  const blocked = (name, target) =>
    step(name, target, "skipped", `the ${base} sync failed`);

  // Worktrees first: a task branch checked out in a run worktree can only be
  // deleted once that worktree is gone.
  for (const path of options.worktrees ?? [])
    steps.push(removeWorktree(ctx, path));
  if (options.branch)
    steps.push(
      baseOk
        ? deleteBranch(ctx, options.branch, options.pr)
        : blocked("branch", options.branch)
    );
  for (const branch of options.rebases ?? [])
    steps.push(baseOk ? rebaseBranch(ctx, branch) : blocked("rebase", branch));

  const status = overallStatus(steps);
  return { status, ...head, summary: summarize(status, steps, dryRun), steps };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: housekeep.mjs run --repo-dir <path> --base <branch> [options]

Tidies a clean local checkout after a pull request merged. Never pushes.

Steps:
  1. A dirty checkout returns status skipped (reason dirty) and changes nothing
  2. git fetch origin <base>, switch to <base>, fast-forward to origin/<base>
     (a base with local commits is reported, not forced)
  3. Each --worktree: git worktree remove (no --force), only for a linked
     worktree of this repository under worktrees.root
  4. --branch with --pr: git branch -D, only when gh pr view reports the pull
     request MERGED with that head, and the branch is not checked out elsewhere
  5. Each --rebase: git rebase origin/<base> <branch>; a conflict is aborted

Options:
  --repo-dir <path>       Repository checkout (required)
  --base <branch>         Base branch (required)
  --branch <name>         Local task branch to delete once merged (needs --pr)
  --pr <url>              Pull request of --branch
  --worktree <path>       Run worktree to remove (repeatable)
  --rebase <branch>       Later branch to rebase onto the new base (repeatable)
  --dry-run               Report the planned steps, change nothing

Output: { status: done|skipped|partial|failed, steps: [{ step, target, result, detail }] }

Exit codes: 0 done, skipped or partial; 1 failed; 2 usage error.

Environment:
  ESP_GH_CMD              JSON array replacing the gh command (tests)`;

const BOOLEAN_OPTIONS = new Set(["dry-run", "help"]);
const REPEATABLE = { worktree: "worktrees", rebase: "rebases" };
const KNOWN = new Set([
  "repo-dir",
  "base",
  "branch",
  "pr",
  "worktree",
  "rebase",
  "dry-run",
  "help"
]);

export function parseArgs(argv) {
  const options = { worktrees: [], rebases: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!KNOWN.has(key))
        throw new HousekeepError(`Unknown option: --${key}`, 2);
      if (BOOLEAN_OPTIONS.has(key) && eq === -1) {
        options[key] = true;
        continue;
      }
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "")
        throw new HousekeepError(`--${key} requires a value`, 2);
      if (REPEATABLE[key]) options[REPEATABLE[key]].push(value);
      else options[key] = value;
    } else positional.push(arg);
  }
  return { command: positional[0], args: positional.slice(1), options };
}

export function run(argv, env = process.env) {
  const { command, args, options } = parseArgs(argv);
  if (options.help || !command)
    return { output: USAGE, exitCode: command ? 0 : 2 };
  if (command !== "run")
    throw new HousekeepError(`Unknown command: ${command}\n\n${USAGE}`, 2);
  if (args.length > 0)
    throw new HousekeepError(`Unexpected argument: ${args[0]}`, 2);
  for (const key of ["repo-dir", "base"])
    if (!options[key]) throw new HousekeepError(`--${key} is required`, 2);
  if (Boolean(options.branch) !== Boolean(options.pr))
    throw new HousekeepError("--branch and --pr go together", 2);
  const result = housekeep(
    {
      repoDir: options["repo-dir"],
      base: options.base,
      branch: options.branch,
      pr: options.pr,
      worktrees: options.worktrees,
      rebases: options.rebases,
      dryRun: options["dry-run"]
    },
    env
  );
  return { output: result, exitCode: result.status === "failed" ? 1 : 0 };
}

function main() {
  try {
    const { output, exitCode = 0 } = run(process.argv.slice(2));
    const text =
      typeof output === "string" ? output : JSON.stringify(output, null, 2);
    process.stdout.write(`${text}\n`);
    process.exitCode = exitCode;
  } catch (err) {
    const known = err instanceof HousekeepError;
    process.stderr.write(
      `housekeep error: ${known ? err.message : (err.stack ?? err)}\n`
    );
    process.exitCode = known ? err.exitCode : 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
