# Decision Policy

Paths here are relative to this file's directory, the plugin's `references/`: resolve them to absolute paths before running a command.

The single definition of how every esp-skills skill and agent handles a choice: a review finding, a review comment, an ambiguous plan step, a failing gate. Skills and agents point here instead of restating the classes, the stop conditions or the risk levels.

## Classes

Classify every item before acting on it. When an item fits several classes, take the most restrictive one (Halt, then B-Scope, then B-Decide, then A-Fix). Reject only applies when the item itself is wrong.

| Class    | Meaning                                                            | Interactive        | Autonomous                                     |
| -------- | ------------------------------------------------------------------ | ------------------ | ---------------------------------------------- |
| A-Fix    | Clear issue, one clear fix                                         | Show and recommend | Fix                                            |
| B-Decide | Valid issue, several reasonable options                            | Ask                | Apply the recommended option, log it           |
| B-Scope  | Changes scope, a public API, the data model, or product behavior   | Ask                | Defer per `fix-review.deferred_items`, log it  |
| Reject   | Invalid, outdated, already handled, or contradicts the conventions | Show the reason    | Reply with the reason (PR) or drop it, log it  |
| Halt     | A stop condition is met (see Stop Conditions)                      | Ask                | Stop this task, write the summary, never merge |

- **A-Fix**: the fix is local, the expected behavior is not in doubt, and the change stays inside the task's scope. Fixing a typo, a missing null check, a wrong test assertion, or a convention violation the repo documents.
- **B-Decide**: the issue is real, but two or more fixes are defensible and none changes scope. Pick the option that best fits the plan, the repo conventions, and the smallest diff. Record the rejected options as `alternatives`.
- **B-Scope**: acting would change what the task delivers: a new feature, a renamed or removed public API, a schema or migration change, a behavior users would notice. Never apply a B-Scope item autonomously.
- **Reject**: the item is wrong for a stated reason: the code already handles it, the comment targets an older revision, it contradicts `AGENTS.md` or the plan, or it is a style preference the repo does not enforce. A Reject always carries the reason.
- **Halt**: continuing would be unsafe or wasteful. Halting is not failure: it hands the task back with a summary.

## Interactive Modes

`--interactive[=off|plan|all]` selects when a skill stops to ask. The default comes from `defaults.interactive` (`off`).

| Mode   | Asks at                                                                                                                | Everything else |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| `off`  | Never. B-Decide applies the recommendation, B-Scope defers, Halt stops                                                 | Autonomous      |
| `plan` | Plan approval only                                                                                                     | Autonomous      |
| `all`  | Plan approval, review findings and pull request review items before each fix (A and B groups), fix-review recap, merge | Interactive     |

- In standalone interactive mode, "Ask" means: ask the user, with the session's question tool if it has one, otherwise in plain text, one question at a time with the recommended answer first.
- A headless session is a non-interactive session (for example `claude -p`, `codex exec`): the harness tells the session that no user can answer. Headless sessions and subagents are always `off`, whatever the flag says. Subagents never ask: they return the question to their caller (see Asking Outside an Interactive Session).

## Asking Outside an Interactive Session

Only the main interactive session asks the user. Everywhere else, "Ask" becomes one of two moves:

- **Apply the autonomous column**: B-Decide applies the recommended option, B-Scope defers, Halt stops. This is the default for headless sessions and for every subagent.
- **Stop and hand the question back**: when no safe default exists (a Halt, or a B-Scope item that cannot be deferred), finish every item that does not depend on the answer, log those decisions, then reply with `Status: needs-decision` and a `Question:` line with the options, the recommended one first (see Replies). A script step ends with `status: awaiting-human` and the question in `blockers`.

The main session then asks the user (with the session's question tool if it has one, otherwise in plain text, one question at a time with the recommended answer first), logs the answer with `source: operator`, and passes it to the next subagent, or to the same one when it continues.

## Stop Conditions

`ship.halt_on` lists the stop conditions a workflow honors. Each key maps to one condition:

| Key                  | Condition                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `critical-security`  | 🔴 A critical security or data-loss finding that cannot be fixed with high confidence                               |
| `gates-exhausted`    | Milestone gates still fail after `ship.max_retries_per_milestone` retries, or the final gates after their fix round |
| `scope-change`       | Plan ambiguity, or a B-Scope item, that changes scope or a public API and cannot be deferred                        |
| `destructive-action` | A destructive or irreversible action: shared-data migration, force push to a shared branch, deletion of data        |
| `budget`             | A configured budget is exhausted (milestones, wall time, rounds)                                                    |

When a condition is met and its key is in `ship.halt_on`:

1. Stop starting new work. Do not merge, and do not push anything the halt is about.
2. Log a decision with `source: policy`, `risk: high`, and the key in `rationale`.
3. Write `summary.md` (see `summary-template.md`) when the skill owns the run.
4. Reply with `Status: halted` (a script records `status: halted` with `ship.mjs halt`), or hand the question back (see Asking Outside an Interactive Session) when a single answer would unblock the task.

A condition whose key is not in `ship.halt_on` becomes a B-Scope item: deferred and logged, never applied.

## Risk

Every decision carries a risk level. It feeds `max_risk` in `run.json` and in the steps `ship.json` records, and `esp-recap --risks`.

| Risk     | Use when                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| `low`    | Local, easily reverted, covered by tests (A-Fix items, Rejects with a clear reason)                                 |
| `medium` | A judgment call a reviewer may disagree with, or a change with weak test coverage (B-Decide)                        |
| `high`   | Touches security, data, public APIs, or merge and deploy behavior; every Halt and every deferral of a critical item |

## Logging

Log a decision when it is made, not at the end of the task. Every B-Decide, B-Scope, Reject and Halt is logged. A-Fix items are logged when a review or comment triggered them, so the PR body can show how each comment was resolved.

```bash
node "../scripts/runs.mjs" decision --run-dir <path> --json '{
  "phase": "fix-review",
  "source": "agent",
  "risk": "medium",
  "decision": "Kept getUser() and added a deprecation note",
  "rationale": "B-Decide: renaming breaks 3 callers outside this task",
  "alternatives": ["Rename to fetchUser()"],
  "files": ["src/user.ts"],
  "refs": ["https://github.com/o/r/pull/12#discussion_r1"],
  "x-esp-class": "B-Decide"
}'
```

- `source`: `agent` for choices the model made, `policy` for rules applied from config (stop conditions, deferrals), `operator` for the user's answers and corrections, and plan amendments.
- `x-esp-class`: the class from this policy (`A-Fix`, `B-Decide`, `B-Scope`, `Reject`, `Halt`).
- `rationale` starts with the class, then the reason.
- Without `--run-dir`, report the same information in the skill output instead.

## Deferred Items

B-Scope items, and items outside the task, are deferred per `fix-review.deferred_items`:

- `follow-up` (default): return the item as a `Discovered:` line of the reply (see Replies), reply on the PR thread with the reason, and resolve it.
- `block`: leave the thread open, end with `awaiting-human`, and do not merge.

Every deferred item has a `type` (`bug`, `debt`, `security`, `docs`, `test`, `follow-up`, `other`), a `title`, and `evidence`. The session that records the step stores them as `discovered_items` with `ship.mjs record`.

## Replies

Every subagent and every skill called by another skill ends its work with a short markdown reply in this format, and nothing after it:

```text
Status: needs-decision
Commit: 3f2a1c9e0b7d4a6f8c5e2d1b0a9f8e7d6c5b4a3f
Summary: Fixed 4 of 5 review findings; F5 renames a public API
Blockers:
- F5 is B-Scope and fix-review.deferred_items is block
Discovered: debt - Legacy rounding helper - src/round.js:1
Question: Rename getUser() to fetchUser()? Options: keep it and defer (recommended); rename it and update 3 callers
```

- `Status:` (always, first line): `done` (the work is complete), `failed` (it could not be done; the reason is in `Summary:`), `halted` (a stop condition is met, see Stop Conditions), or `needs-decision` (a question blocks the rest, see Asking Outside an Interactive Session)
- `Commit:` (when the work made a commit): the full SHA from `git rev-parse HEAD`
- `Summary:` (always): one or two sentences on what changed or what was found
- `Blockers:` (when the caller must act): what stops the task, on the same line for one blocker or as a `-` list under it for several
- `Discovered:` (one line per item): `<type> - <title> - <evidence>`, for issues outside the task (see Deferred Items)
- `Question:` (with `needs-decision` only): the question and its options, the recommended one first

A script outcome maps to the reply status: `done` and `merged` are `done`, `awaiting-human` is `needs-decision` (its `blockers` hold the question), `halted` and `failed` stay as they are.

The caller reads changed files from git and gate results from its own gate run, so replies carry no file lists, gate tables or JSON. Details go to the run dir (`notes.md`, `decisions.jsonl`), not the reply. The orchestrating session records the facts it needs with `ship.mjs record`, `ship.mjs phase` and `ship.mjs milestone finish`. A skill's own report to the user may say more, but when another skill called it, it ends with this reply.
