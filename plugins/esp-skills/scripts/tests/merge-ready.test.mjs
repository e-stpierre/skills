import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildContext,
  classifyChecks,
  cmdMerge,
  evaluate,
  ghClient,
  haltSignals,
  MergeError,
  mergePolicy,
  mergeWaitSettings,
  report,
  resolveMethod,
  run,
  waitForChecks,
  waitForMerge,
  waitSettings
} from "../merge-ready.mjs";
import { appendDecision, checkFile } from "../runs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "merge-ready.mjs");
const RUNS = join(HERE, "..", "runs.mjs");
const NOW = "2026-11-08T12:00:00.000Z";
const HEAD = "d".repeat(40);
const URL = "https://github.com/o/r/pull/9";

let tmp;
let home;
let runDir;
const env = (extra = {}) => ({
  ...process.env,
  ESP_SKILLS_HOME: home,
  ESP_RUNS_NOW: NOW,
  ...extra
});

function cli(script, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...env(), ...extraEnv }
  });
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json: () => JSON.parse(r.stdout)
  };
}

function facts(overrides = {}) {
  return {
    pr: {
      number: 9,
      url: URL,
      state: "OPEN",
      draft: false,
      head: HEAD,
      branch: "feature/x",
      base: "main",
      cross_repository: false,
      mergeable: "MERGEABLE",
      merge_state: "CLEAN",
      review_decision: null,
      latest_reviews: [],
      auto_merge: false,
      ...overrides.pr
    },
    settings: {
      squash: true,
      rebase: true,
      merge: true,
      delete_branch_on_merge: false,
      merge_queue: false,
      in_merge_queue: false,
      ...overrides.settings
    },
    rules: overrides.rules ?? [],
    protection:
      overrides.protection === undefined
        ? { linear_history: false }
        : overrides.protection,
    checks: overrides.checks ?? [{ name: "test", bucket: "pass" }],
    required: overrides.required ?? [{ name: "test", bucket: "pass" }],
    threads: overrides.threads ?? [],
    compare: overrides.compare ?? { status: "ahead", ahead_by: 2, behind_by: 0 }
  };
}

function fakeClient(data = facts()) {
  const calls = { merge: [], deleteBranch: [] };
  return {
    calls,
    data,
    pr: () => ({ ...data.pr }),
    settings: () => ({ ...data.settings }),
    rules: () => data.rules,
    protection: () => data.protection,
    checks: (n, { required = false } = {}) =>
      required ? data.required : data.checks,
    unresolvedThreads: () => data.threads,
    compare: () => data.compare,
    merge: (number, opts) => {
      calls.merge.push({ number, ...opts });
      return "";
    },
    deleteBranch: (repo, branch) => {
      calls.deleteBranch.push({ repo, branch });
      return "deleted";
    }
  };
}

function ctx(
  client = fakeClient(),
  { options = {}, extraEnv = {}, io = {} } = {}
) {
  return buildContext(
    { "run-dir": runDir, "project-dir": tmp, ...options },
    env(extraEnv),
    {
      client,
      sleep: async () => {},
      inspectWorktree: () => ({
        path: null,
        remove: false,
        reason: "not a linked worktree"
      }),
      log: () => {},
      ...io
    }
  );
}

const jsonl = (name) =>
  existsSync(join(runDir, name))
    ? readFileSync(join(runDir, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "esp-merge-"));
  home = join(tmp, "home");
  mkdirSync(home);
  const created = cli(RUNS, [
    "create",
    "toy",
    "--root",
    join(tmp, "runs"),
    "--project-dir",
    tmp
  ]);
  assert.equal(created.code, 0, created.stderr);
  runDir = created.json().run_dir;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ALL = { squash: true, rebase: true, merge: true };

describe("method resolution", () => {
  test("rule 1: the policy combines repo settings, ruleset methods and linear history", () => {
    const policy = mergePolicy(
      { ...ALL, delete_branch_on_merge: true },
      [
        {
          type: "pull_request",
          parameters: { allowed_merge_methods: ["squash", "merge"] }
        },
        { type: "required_linear_history" }
      ],
      null
    );
    assert.deepEqual(policy.allowed, ["squash", "merge"]);
    assert.equal(policy.linear_history, true);
    assert.equal(policy.merge_queue, false);
    assert.equal(policy.delete_branch_on_merge, true);
    assert.equal(
      mergePolicy({ squash: true }, [], { linear_history: true })
        .linear_history,
      true
    );
  });

  test("rule 2: a merge queue enqueues and lets the queue decide", () => {
    const fromSettings = resolveMethod(
      mergePolicy({ ...ALL, merge_queue: true })
    );
    assert.equal(fromSettings.queue, true);
    assert.equal(fromSettings.method, "squash");
    assert.match(fromSettings.reason, /merge queue/);
    const fromRule = resolveMethod(
      mergePolicy(ALL, [
        { type: "merge_queue", parameters: { merge_method: "REBASE" } }
      ])
    );
    assert.equal(fromRule.queue, true);
    assert.equal(fromRule.method, "rebase");
  });

  test("rule 3: a single allowed method is used", () => {
    const out = resolveMethod(
      mergePolicy({ squash: false, rebase: true, merge: false }),
      { preference: ["squash", "merge"] }
    );
    assert.equal(out.method, "rebase");
    assert.match(out.reason, /only method allowed/);
    assert.deepEqual(out.alternatives, []);
  });

  test("rule 4: several methods use the first allowed in preference, excluding merge under linear history", () => {
    const out = resolveMethod(
      mergePolicy({ squash: false, rebase: true, merge: true }),
      { preference: ["squash", "merge", "rebase"] }
    );
    assert.equal(out.method, "merge");
    assert.deepEqual(out.alternatives, ["rebase"]);
    const linear = resolveMethod(
      mergePolicy({ squash: false, rebase: true, merge: true }, [
        { type: "required_linear_history" }
      ]),
      {
        preference: ["merge", "rebase"]
      }
    );
    assert.equal(linear.method, "rebase");
    assert.match(linear.reason, /only method allowed.*linear history/);
  });

  test("rule 5: an explicit method overrides, and errors when it is not allowed", () => {
    assert.equal(
      resolveMethod(mergePolicy(ALL), { method: "rebase" }).method,
      "rebase"
    );
    assert.throws(
      () => resolveMethod(mergePolicy({ squash: true }), { method: "merge" }),
      /not allowed: the repository does not allow it/
    );
    assert.throws(
      () =>
        resolveMethod(mergePolicy(ALL, [{ type: "required_linear_history" }]), {
          method: "merge"
        }),
      /not allowed: linear history is required/
    );
    assert.throws(
      () => resolveMethod(mergePolicy(ALL), { method: "fast-forward" }),
      (err) => err instanceof MergeError && err.exitCode === 2
    );
  });

  test("no allowed method is an error", () => {
    assert.throws(
      () =>
        resolveMethod(
          mergePolicy({ merge: true }, [{ type: "required_linear_history" }])
        ),
      /No merge method is allowed/
    );
  });

  test("rule 6: the method and its reason are logged as a decision on merge", async () => {
    const client = fakeClient();
    const block = await cmdMerge(ctx(client), "9");
    const [decision] = jsonl("decisions.jsonl").filter(
      (d) => d.phase === "merge"
    );
    assert.equal(decision.decision, "Merged #9 with squash");
    assert.match(
      decision.rationale,
      /^Method: first allowed method in merge.preference/
    );
    assert.deepEqual(decision.alternatives, ["rebase", "merge"]);
    assert.equal(block.outputs.decision, decision.id);
  });
});

describe("conditions", () => {
  function evaluateFacts(f, config = {}) {
    const policy = {
      ...mergePolicy(f.settings, f.rules, f.protection),
      in_merge_queue: f.settings.in_merge_queue
    };
    const checks = classifyChecks(f.checks, f.required, {
      requireGreen: config.require_green_checks !== false
    });
    return evaluate(
      {
        pr: f.pr,
        policy,
        checks,
        threads: f.threads,
        compare: f.compare,
        halt: { known: false, reasons: [] }
      },
      config
    );
  }
  const status = (out, name) => out.conditions.find((c) => c.name === name);

  test("every condition passes on a clean pull request", () => {
    const out = evaluateFacts(facts());
    assert.equal(out.ready, true);
    assert.equal(out.outcome, "ready");
    assert.deepEqual(
      out.conditions.map((c) => [c.name, c.status]),
      [
        ["open", "pass"],
        ["halt", "pass"],
        ["draft", "pass"],
        ["changes-requested", "pass"],
        ["threads", "pass"],
        ["checks", "pass"],
        ["up-to-date", "pass"],
        ["branch-protection", "pass"]
      ]
    );
  });

  test("draft, changes requested, unresolved threads and failing checks block with a reason", () => {
    const out = evaluateFacts(
      facts({
        pr: {
          draft: true,
          latest_reviews: [{ login: "alice", state: "CHANGES_REQUESTED" }]
        },
        threads: ["u1", "u2"],
        checks: [
          { name: "test", bucket: "fail" },
          { name: "lint", bucket: "pass" }
        ]
      })
    );
    assert.equal(out.outcome, "blocked");
    assert.equal(status(out, "draft").status, "fail");
    assert.match(status(out, "changes-requested").reason, /alice/);
    assert.match(status(out, "threads").reason, /2 unresolved/);
    assert.match(status(out, "checks").reason, /failing checks: test/);
  });

  test("require_resolved_threads false ignores threads; require_green_checks false only counts required checks", () => {
    const out = evaluateFacts(
      facts({
        threads: ["u1"],
        checks: [
          { name: "optional", bucket: "fail" },
          { name: "test", bucket: "pass" }
        ]
      }),
      { require_resolved_threads: false, require_green_checks: false }
    );
    assert.equal(out.outcome, "ready");
    assert.match(status(out, "threads").reason, /not required/);
    assert.match(status(out, "checks").reason, /required checks green/);
  });

  test("pending checks, including required checks that have not reported, give pending", () => {
    const out = evaluateFacts(
      facts({ checks: [], required: [{ name: "build", bucket: "pending" }] }),
      { require_green_checks: false }
    );
    assert.equal(out.outcome, "pending");
    assert.deepEqual(status(out, "checks").pending, ["build"]);
  });

  test("behind the base asks for a rebase; conflicts are reported apart", () => {
    const behind = evaluateFacts(facts({ compare: { behind_by: 3 } }));
    assert.equal(behind.outcome, "behind");
    assert.match(status(behind, "up-to-date").reason, /behind main by 3/);
    const conflict = evaluateFacts(facts({ pr: { mergeable: "CONFLICTING" } }));
    assert.equal(conflict.outcome, "conflict");
  });

  test("a merge queue skips the up-to-date condition", () => {
    const out = evaluateFacts(
      facts({ settings: { merge_queue: true }, compare: { behind_by: 5 } })
    );
    assert.equal(status(out, "up-to-date").status, "pass");
    assert.equal(out.outcome, "ready");
  });

  test("unmet branch protection gives protected, but a BLOCKED state caused by pending checks does not", () => {
    const review = evaluateFacts(
      facts({ pr: { review_decision: "REVIEW_REQUIRED" } })
    );
    assert.equal(review.outcome, "protected");
    const blocked = evaluateFacts(facts({ pr: { merge_state: "BLOCKED" } }));
    assert.equal(blocked.outcome, "protected");
    const pending = evaluateFacts(
      facts({
        pr: { merge_state: "BLOCKED" },
        checks: [{ name: "test", bucket: "pending" }]
      })
    );
    assert.equal(pending.outcome, "pending");
    assert.equal(status(pending, "branch-protection").status, "pass");
  });

  test("closed and merged pull requests", () => {
    assert.equal(
      evaluateFacts(facts({ pr: { state: "CLOSED" } })).outcome,
      "closed"
    );
    assert.equal(
      evaluateFacts(facts({ pr: { state: "MERGED" } })).outcome,
      "merged"
    );
  });

  test("halt signals: run status, Halt decisions, and operator decisions that lift them", () => {
    assert.deepEqual(haltSignals(null), { known: false, reasons: [] });
    assert.deepEqual(haltSignals(runDir).reasons, []);
    const halt = appendDecision(
      runDir,
      {
        phase: "fix-review",
        source: "policy",
        risk: "high",
        decision: "Stopped",
        rationale: "Halt: critical-security",
        "x-esp-class": "Halt"
      },
      env()
    );
    assert.match(haltSignals(runDir).reasons[0], /^D001: Stopped/);
    appendDecision(
      runDir,
      {
        phase: "merge",
        source: "operator",
        risk: "low",
        decision: "Fixed by hand",
        rationale: "operator",
        refs: [halt.id]
      },
      env()
    );
    assert.deepEqual(haltSignals(runDir).reasons, []);
    const runPath = join(runDir, "run.json");
    writeFileSync(
      runPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(runPath, "utf8")),
        status: "halted"
      })
    );
    assert.deepEqual(haltSignals(runDir).reasons, ["run status is halted"]);
  });
});

describe("merge", () => {
  test("a ready pull request merges with the resolved method, deletes the branch, and logs it", async () => {
    const client = fakeClient();
    const block = await cmdMerge(ctx(client), "9");
    assert.equal(block.status, "merged");
    assert.deepEqual(client.calls.merge, [
      { number: 9, method: "squash", head: HEAD, auto: false }
    ]);
    assert.deepEqual(client.calls.deleteBranch, [
      { repo: "o/r", branch: "feature/x" }
    ]);
    assert.equal(block.outputs.merged, true);
    assert.equal(block.outputs.cleanup.remote_branch, "deleted");
    assert.equal(block.pr, URL);
    assert.deepEqual(
      readdirSync(runDir).filter((f) => f.endsWith(".jsonl")),
      ["decisions.jsonl"]
    );
    assert.equal(checkFile(join(runDir, "decisions.jsonl")).valid, true);
  });

  test("the branch is kept for forks, with delete_branch false, and left to GitHub when it deletes on merge", async () => {
    const fork = fakeClient(facts({ pr: { cross_repository: true } }));
    assert.match(
      (await cmdMerge(ctx(fork), "9")).outputs.cleanup.remote_branch,
      /fork/
    );
    const github = fakeClient(
      facts({ settings: { delete_branch_on_merge: true } })
    );
    assert.match(
      (await cmdMerge(ctx(github), "9")).outputs.cleanup.remote_branch,
      /deleted by GitHub/
    );
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ merge: { delete_branch: false } })
    );
    const kept = fakeClient();
    assert.match(
      (await cmdMerge(ctx(kept), "9")).outputs.cleanup.remote_branch,
      /delete_branch false/
    );
    assert.equal(
      fork.calls.deleteBranch.length +
        github.calls.deleteBranch.length +
        kept.calls.deleteBranch.length,
      0
    );
  });

  test("unmet branch protection yields awaiting-human and is never bypassed", async () => {
    const client = fakeClient(
      facts({ pr: { review_decision: "REVIEW_REQUIRED" } })
    );
    const block = await cmdMerge(ctx(client), "9");
    assert.equal(block.status, "awaiting-human");
    assert.equal(block.outputs.outcome, "protected");
    assert.match(block.blockers.join(" "), /review/i);
    assert.equal(client.calls.merge.length, 0);
    const [decision] = jsonl("decisions.jsonl");
    assert.match(decision.decision, /Did not merge #9: protected/);
  });

  test("a halted run never merges", async () => {
    appendDecision(
      runDir,
      {
        phase: "build",
        source: "policy",
        risk: "high",
        decision: "Stopped M2",
        rationale: "Halt: gates-exhausted",
        "x-esp-class": "Halt"
      },
      env()
    );
    const client = fakeClient();
    const block = await cmdMerge(ctx(client), "9");
    assert.equal(block.status, "halted");
    assert.equal(block.max_risk, "high");
    assert.equal(client.calls.merge.length, 0);
  });

  test("--halt records a Halt decision and reports halted", async () => {
    const client = fakeClient();
    const block = await cmdMerge(ctx(client), "9", {
      halt: "rebase conflict in src/a.js"
    });
    assert.equal(block.status, "halted");
    assert.deepEqual(block.blockers, ["rebase conflict in src/a.js"]);
    const [decision] = jsonl("decisions.jsonl");
    assert.equal(decision["x-esp-class"], "Halt");
    assert.equal(client.calls.merge.length, 0);
  });

  test("behind the base reports behind without merging", async () => {
    const client = fakeClient(facts({ compare: { behind_by: 1 } }));
    const block = await cmdMerge(ctx(client), "9");
    assert.equal(block.outputs.outcome, "behind");
    assert.equal(block.status, "awaiting-human");
    assert.equal(client.calls.merge.length, 0);
  });

  test("an explicit method the repository does not allow fails the merge, not silently falls back", async () => {
    const client = fakeClient(facts({ settings: { merge: false } }));
    const block = await cmdMerge(
      ctx(client, { options: { method: "merge" } }),
      "9"
    );
    assert.equal(block.status, "awaiting-human");
    assert.match(block.summary, /not allowed/);
    assert.equal(client.calls.merge.length, 0);
  });

  test("a merge queue enqueues with --auto; an already queued pull request is not enqueued again", async () => {
    const client = fakeClient(facts({ settings: { merge_queue: true } }));
    const block = await cmdMerge(ctx(client), "9");
    assert.equal(block.status, "done");
    assert.equal(block.outputs.outcome, "queued");
    assert.equal(client.calls.merge[0].auto, true);
    assert.match(block.outputs.cleanup.remote_branch, /pending/);
    const queued = fakeClient(
      facts({ settings: { merge_queue: true, in_merge_queue: true } })
    );
    assert.equal(
      (await cmdMerge(ctx(queued), "9")).outputs.already_queued,
      true
    );
    assert.equal(queued.calls.merge.length, 0);
  });

  test("use_auto_merge enables auto-merge while checks are pending", async () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ merge: { use_auto_merge: true } })
    );
    const client = fakeClient(
      facts({
        checks: [{ name: "test", bucket: "pending" }],
        required: [{ name: "test", bucket: "pending" }]
      })
    );
    const block = await cmdMerge(ctx(client), "9");
    assert.equal(block.outputs.outcome, "auto-merge");
    assert.equal(block.status, "done");
    assert.deepEqual(client.calls.merge, [
      { number: 9, method: "squash", head: HEAD, auto: true }
    ]);
  });

  test("merge.enabled false and --dry-run never merge", async () => {
    const dry = fakeClient();
    const block = await cmdMerge(ctx(dry), "9", { dryRun: true });
    assert.equal(block.outputs.outcome, "dry-run");
    assert.match(block.summary, /would merge with squash/);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ merge: { enabled: false } })
    );
    const disabled = fakeClient();
    assert.equal(
      (await cmdMerge(ctx(disabled), "9")).outputs.outcome,
      "disabled"
    );
    assert.equal(dry.calls.merge.length + disabled.calls.merge.length, 0);
  });

  test("an already merged pull request reports merged", async () => {
    const client = fakeClient(facts({ pr: { state: "MERGED" } }));
    const block = await cmdMerge(ctx(client), "9");
    assert.equal(block.status, "merged");
    assert.equal(block.outputs.already_merged, true);
    assert.equal(client.calls.merge.length, 0);
  });
});

describe("final re-check", () => {
  test("a base that moved after the last check ends behind without merging", async () => {
    const client = fakeClient();
    const c = ctx(client);
    assert.equal(report(c, "9").outcome, "ready");
    client.data.compare = { ...client.data.compare, behind_by: 2 };
    const block = await cmdMerge(c, "9");
    assert.equal(block.outputs.outcome, "behind");
    assert.equal(client.calls.merge.length, 0);
  });
});

describe("check", () => {
  test("report lists every condition and the method", () => {
    const out = report(ctx(fakeClient(facts({ threads: ["u1"] }))), "9");
    assert.equal(out.ready, false);
    assert.equal(out.outcome, "blocked");
    assert.equal(out.method.method, "squash");
    assert.equal(out.repo, "o/r");
    assert.equal(out.conditions.length, 8);
  });

  test("no checks on a fresh head is pending during the grace period", () => {
    const fresh = fakeClient(facts({ checks: [], required: [] }));
    fresh.commitDate = () => new Date().toISOString();
    const pending = report(ctx(fresh), "9");
    assert.equal(pending.outcome, "pending");
    const old = fakeClient(facts({ checks: [], required: [] }));
    old.commitDate = () => "2020-01-01T00:00:00Z";
    const out = report(ctx(old), "9");
    assert.equal(
      out.conditions.find((c) => c.name === "checks").status,
      "pass"
    );
  });

  test("--checks none-expected skips the grace period; a failing check still fails", () => {
    const at = new Date(NOW);
    const tenSecondsAgo = new Date(at.getTime() - 10_000).toISOString();
    const noChecks = () => {
      const client = fakeClient(facts({ checks: [], required: [] }));
      client.commitDate = () => tenSecondsAgo;
      return client;
    };
    const checksOf = (out) => out.conditions.find((c) => c.name === "checks");
    const io = { now: () => at };
    const byDefault = report(ctx(noChecks(), { io }), "9");
    assert.equal(byDefault.outcome, "pending");
    assert.equal(checksOf(byDefault).status, "pending");
    const none = report(
      ctx(noChecks(), { io, options: { checks: "none-expected" } }),
      "9"
    );
    assert.equal(checksOf(none).status, "pass");
    assert.equal(none.outcome, "ready");
    const failing = fakeClient(
      facts({ checks: [{ name: "test", bucket: "fail" }] })
    );
    const out = report(
      ctx(failing, { io, options: { checks: "none-expected" } }),
      "9"
    );
    assert.equal(checksOf(out).status, "fail");
    assert.equal(out.outcome, "blocked");
  });

  test("--checks rejects an unknown mode with a usage error", () => {
    assert.throws(
      () => ctx(fakeClient(), { options: { checks: "optional" } }),
      (err) => err instanceof MergeError && err.exitCode === 2
    );
  });

  test("--wait polls until checks finish", async () => {
    const data = facts({ checks: [{ name: "test", bucket: "pending" }] });
    const client = fakeClient(data);
    const c = ctx(client, {
      io: {
        sleep: async () => {
          data.checks = [{ name: "test", bucket: "pass" }];
        }
      }
    });
    const out = await waitForChecks(c, "9", {
      timeoutMinutes: 5,
      pollSeconds: 1
    });
    assert.equal(out.outcome, "ready");
    assert.equal(out.polls, 2);
  });

  test("--wait reads merge.poll_seconds unless --poll-seconds is given", () => {
    assert.deepEqual(waitSettings({}, {}), {
      timeoutMinutes: 30,
      pollSeconds: 30
    });
    assert.deepEqual(
      waitSettings({}, { poll_seconds: 5, checks_timeout_minutes: 10 }),
      { timeoutMinutes: 10, pollSeconds: 5 }
    );
    assert.equal(
      waitSettings({ "poll-seconds": "2" }, { poll_seconds: 5 }).pollSeconds,
      2
    );
    assert.throws(
      () => waitSettings({ "poll-seconds": "0" }, {}),
      /--poll-seconds must be a number >= 1/
    );
  });

  test("--wait times out while checks stay pending", async () => {
    const client = fakeClient(
      facts({ checks: [{ name: "test", bucket: "pending" }] })
    );
    const out = await waitForChecks(ctx(client), "9", {
      timeoutMinutes: 0,
      pollSeconds: 1
    });
    assert.equal(out.outcome, "pending");
    assert.equal(out.timed_out, true);
  });
});

describe("wait-merge", () => {
  const MERGE_SHA = "e".repeat(40);

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

  function waitCtx(client, time, onSleep = () => {}) {
    return ctx(client, {
      io: {
        now: time.now,
        sleep: async (ms) => {
          time.advance(ms);
          onSleep();
        }
      }
    });
  }

  const state = () =>
    JSON.parse(readFileSync(join(runDir, "merge-wait.json"), "utf8"));

  test("returns merged with the merge commit once someone merges the pull request", async () => {
    const client = fakeClient();
    const time = clock();
    let polls = 0;
    const block = await waitForMerge(
      waitCtx(client, time, () => {
        polls += 1;
        if (polls === 2)
          client.data.pr = {
            ...client.data.pr,
            state: "MERGED",
            merge_commit: MERGE_SHA
          };
      }),
      "9",
      { timeoutMinutes: 60, pollSeconds: 30 }
    );
    assert.equal(block.status, "merged");
    assert.equal(block.outputs.merge_commit, MERGE_SHA);
    assert.equal(block.outputs.pr, 9);
    assert.equal(block.outputs.url, URL);
    assert.equal(block.outputs.polls, 3);
    assert.equal(block.blockers, undefined);
    assert.equal(state().status, "merged");
    assert.equal(client.calls.merge.length, 0);
  });

  test("returns failed for a pull request closed without merging", async () => {
    const client = fakeClient(facts({ pr: { state: "CLOSED" } }));
    const block = await waitForMerge(waitCtx(client, clock()), "9", {
      timeoutMinutes: 60,
      pollSeconds: 30
    });
    assert.equal(block.status, "failed");
    assert.equal(block.outputs.reason, "closed");
    assert.match(block.blockers[0], /closed without merging/);
  });

  test("a rerun after an interrupted wait keeps the first deadline", async () => {
    const time = clock();
    // The shell kills the first wait during its first sleep.
    await assert.rejects(
      waitForMerge(
        waitCtx(fakeClient(), time, () => {
          throw new Error("killed");
        }),
        "9",
        { timeoutMinutes: 2, pollSeconds: 30 }
      ),
      /killed/
    );
    assert.equal(state().ended_at, null);
    assert.equal(state().deadline, "2026-11-08T12:02:00.000Z");

    // A rerun with a longer timeout still ends at the first deadline.
    const rerun = await waitForMerge(waitCtx(fakeClient(), time), "9", {
      timeoutMinutes: 60,
      pollSeconds: 30
    });
    assert.equal(rerun.status, "awaiting-human");
    assert.equal(rerun.outputs.timed_out, true);
    assert.equal(rerun.outputs.deadline, "2026-11-08T12:02:00.000Z");
    assert.equal(time.now().toISOString(), "2026-11-08T12:02:00.000Z");
    assert.equal(state().started_at, NOW);
  });

  test("a rerun after a wait that ended at its deadline starts a new deadline", async () => {
    const time = clock();
    const first = await waitForMerge(waitCtx(fakeClient(), time), "9", {
      timeoutMinutes: 2,
      pollSeconds: 30
    });
    assert.equal(first.status, "awaiting-human");
    assert.equal(first.outputs.deadline, "2026-11-08T12:02:00.000Z");
    assert.match(first.blockers[0], /a rerun starts a new deadline/);

    const rerun = await waitForMerge(waitCtx(fakeClient(), time), "9", {
      timeoutMinutes: 3,
      pollSeconds: 30
    });
    assert.equal(rerun.status, "awaiting-human");
    assert.equal(rerun.outputs.deadline, "2026-11-08T12:05:00.000Z");
    assert.equal(state().started_at, "2026-11-08T12:02:00.000Z");
    assert.equal(state().deadline, "2026-11-08T12:05:00.000Z");
  });

  test("an interrupted wait resumes with its deadline; another pull request starts a new one", async () => {
    writeFileSync(
      join(runDir, "merge-wait.json"),
      JSON.stringify({
        pr: 9,
        url: URL,
        started_at: "2026-11-08T11:00:00.000Z",
        deadline: "2026-11-08T12:01:00.000Z",
        status: "waiting",
        ended_at: null
      })
    );
    const time = clock();
    const resumed = await waitForMerge(waitCtx(fakeClient(), time), "9", {
      timeoutMinutes: 60,
      pollSeconds: 30
    });
    assert.equal(resumed.status, "awaiting-human");
    assert.equal(resumed.outputs.polls, 3);
    assert.equal(state().started_at, "2026-11-08T11:00:00.000Z");

    const other = fakeClient(
      facts({ pr: { number: 10, url: "https://github.com/o/r/pull/10" } })
    );
    const fresh = await waitForMerge(waitCtx(other, clock()), "10", {
      timeoutMinutes: 1,
      pollSeconds: 30
    });
    assert.equal(fresh.outputs.deadline, "2026-11-08T12:01:00.000Z");
    assert.equal(state().pr, 10);
    assert.equal(state().started_at, NOW);
  });

  test("reads merge.human_wait_minutes and merge.poll_seconds unless given", () => {
    assert.deepEqual(mergeWaitSettings({}, {}), {
      timeoutMinutes: 1440,
      pollSeconds: 30
    });
    assert.deepEqual(
      mergeWaitSettings({}, { human_wait_minutes: 60, poll_seconds: 10 }),
      { timeoutMinutes: 60, pollSeconds: 10 }
    );
    assert.deepEqual(
      mergeWaitSettings(
        { "wait-minutes": "5", "poll-seconds": "2" },
        { human_wait_minutes: 60 }
      ),
      { timeoutMinutes: 5, pollSeconds: 2 }
    );
  });
});

describe("gh client rules", () => {
  const rulesWith = (stderr, code) => {
    const fakeGh = join(tmp, "gh-rules.cjs");
    writeFileSync(
      fakeGh,
      `console.error(${JSON.stringify(stderr)}); process.exit(${code});\n`
    );
    const client = ghClient({
      cwd: tmp,
      env: { ...env(), ESP_GH_CMD: JSON.stringify([process.execPath, fakeGh]) }
    });
    return () => client.rules("o/r", "main");
  };

  test("a 404 means no rulesets", () => {
    assert.deepEqual(rulesWith("gh: Not Found (HTTP 404)", 1)(), []);
  });

  test("the free-plan 403 on a private repository means no rulesets", () => {
    assert.deepEqual(
      rulesWith(
        "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)",
        1
      )(),
      []
    );
  });

  test("any other 403 still fails", () => {
    assert.throws(
      rulesWith("gh: Resource not accessible by integration (HTTP 403)", 1),
      MergeError
    );
  });
});

describe("CLI", () => {
  test("check and merge through the command line with a fake gh", () => {
    const fakeGh = join(tmp, "gh.cjs");
    const log = join(tmp, "gh.log");
    writeFileSync(
      fakeGh,
      `const fs = require("node:fs");
const a = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(log)}, a.split("\\n")[0] + "\\n");
if (a.startsWith("pr view")) console.log(JSON.stringify({ number: 9, url: "${URL}", state: "OPEN", isDraft: false, headRefOid: "${HEAD}", headRefName: "feature/x", baseRefName: "main", isCrossRepository: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", latestReviews: [], autoMergeRequest: null }));
else if (a.startsWith("pr checks") && a.includes("--required")) { console.error("no required checks reported on the 'feature/x' branch"); process.exit(1); }
else if (a.startsWith("pr checks")) console.log(JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass", link: "", workflow: "ci" }]));
else if (a.startsWith("api graphql") && a.includes("reviewThreads")) console.log("");
else if (a.startsWith("api graphql") && a.includes("branchProtectionRule")) console.log("null");
else if (a.startsWith("api graphql")) console.log(JSON.stringify({ squashMergeAllowed: false, rebaseMergeAllowed: true, mergeCommitAllowed: true, deleteBranchOnMerge: true, pullRequest: { isMergeQueueEnabled: false, isInMergeQueue: false } }));
else if (a.includes("/rules/branches/")) console.log(JSON.stringify({ type: "required_linear_history", parameters: null }));
else if (a.includes("/compare/")) console.log(JSON.stringify({ status: "ahead", ahead_by: 1, behind_by: 0 }));
else if (a.startsWith("pr merge")) console.log("merged");
else { console.error("unexpected: " + a); process.exit(1); }
`
    );
    const ghEnv = { ESP_GH_CMD: JSON.stringify([process.execPath, fakeGh]) };
    const check = cli(SCRIPT, ["check", "9", "--project-dir", tmp], ghEnv);
    assert.equal(check.code, 0, check.stderr);
    assert.equal(check.json().ready, true);
    assert.equal(check.json().method.method, "rebase");
    assert.equal(check.json().policy.linear_history, true);

    const merged = cli(
      SCRIPT,
      ["merge", "9", "--run-dir", runDir, "--project-dir", tmp],
      ghEnv
    );
    assert.equal(merged.code, 0, merged.stderr);
    const block = JSON.parse(merged.stdout.trim().split("\n").at(-1));
    assert.equal(block.status, "merged");
    assert.equal(block.outputs.method, "rebase");
    assert.match(
      readFileSync(log, "utf8"),
      new RegExp(`pr merge 9 --rebase --match-head-commit ${HEAD}`)
    );

    const usage = cli(SCRIPT, ["merge", "--method", "fast"], ghEnv);
    assert.equal(usage.code, 2);
    const checksUsage = cli(SCRIPT, ["check", "--checks", "some"], ghEnv);
    assert.equal(checksUsage.code, 2);
    assert.match(
      checksUsage.stderr,
      /--checks must be required or none-expected/
    );
  });

  test("wait-merge prints the outcome block and exits 1 for a closed pull request", async () => {
    const io = { client: fakeClient(), sleep: async () => {}, log: () => {} };
    io.client.data.pr = {
      ...io.client.data.pr,
      state: "MERGED",
      merge_commit: "f".repeat(40)
    };
    const merged = await run(
      ["wait-merge", "9", "--run-dir", runDir, "--project-dir", tmp],
      env(),
      io
    );
    assert.equal(merged.exitCode, 0);
    assert.equal(
      JSON.parse(merged.output).outputs.merge_commit,
      "f".repeat(40)
    );
    io.client.data.pr = { ...io.client.data.pr, state: "CLOSED" };
    const closed = await run(
      ["wait-merge", "9", "--project-dir", tmp],
      env(),
      io
    );
    assert.equal(closed.exitCode, 1);
    assert.equal(JSON.parse(closed.output).status, "failed");
  });

  test("run without a command prints usage with exit 2", async () => {
    const out = await run([], env());
    assert.equal(out.exitCode, 2);
  });
});
