---
name: esp-review
description: Code review in a fresh context, returning verified findings classified for a fixer. Use when asked to review local changes, a branch, a ref range or a pull request.
argument-hint: "[-a|--focus <area>] [-p|--plan <path>] [-t|--target <target>] [-i|--interactive <mode>] [-s|--second-opinion <tool>] [-d|--run-dir <path>]"
---

# ESP Review

## Overview

Resolve a diff (local changes, a branch, a ref range, or a GitHub pull request), hand it to the read-only `esp-reviewer` in a fresh context, and report its verified findings, each classified with a severity and a fix, so a fixer (`esp-fix-review --internal`, `esp-ship`) can act without asking.

## Arguments

### Definitions

Read each option by its short or its long name (`-t main`, `--target main` or `--target=main`). Quote a value with spaces (`-t "PR 42"`).

- **`[-a|--focus <area>]`** (optional): What to weigh most. A comma-separated list of dimension names (`security,tests`) reviews only those dimensions. Any other text (`token refresh`) is a concern the reviewer weighs more heavily, on the configured dimensions.
- **`[-p|--plan <path>]`** (optional): Plan the diff implements, for the `plan-conformance` dimension. With `--run-dir`, defaults to the latest plan of the run (`runs.mjs plan`). Without a plan, `plan-conformance` is skipped.
- **`[-t|--target <target>]`** (optional): What to review. Defaults to the local changes (staged, unstaged and untracked, against HEAD), or, when the tree is clean, the current branch against its merge base with the default branch. Values:
  - `staged` or `unstaged`: only those changes
  - `<ref>` (`main`, `origin/main`): commits on HEAD that are not on `<ref>`, from the merge base
  - `<base>..<head>` or `<base>...<head>`: an explicit range
  - `PR <number>`, `#<number>`, or a pull request URL: a GitHub pull request, through `gh`
- **`[-i|--interactive <mode>]`** (optional): `off`, `plan` or `all`. Only `all` stops after the review to settle B-Decide and B-Scope findings with the user. Defaults to `defaults.interactive` (`off`). Headless sessions always use `off`.
- **`[-s|--second-opinion <tool>]`** (optional): `none` or `codex`. `codex` also runs a read-only Codex review of the same target, whose findings the reviewer verifies with its own. Defaults to `review.second_opinion` (`none`).
- **`[-d|--run-dir <path>]`** (optional): Run directory owned by a parent skill (esp-ship). The diff, the review and the findings are saved there, and the outcome is recorded as step `review-<N>` in `ship.json`. Without it, the skill writes them to a temporary directory and creates no run.

### Values

Arguments: $ARGUMENTS

## Additional Resources

- For the reviewer's method, finding format and severity scale, see [esp-reviewer.md](../../../agents/esp-reviewer.md): read it in step 7 when the reviewer runs inline
- For `codex.mjs` and Codex failures, see [esp-codex](../../runtime/esp-codex/SKILL.md): read it when the Codex second opinion fails with an unknown cause
- For the finding classes and the reply format (Replies), see [decision-policy.md](../../../references/decision-policy.md): read it before the interactive review or the report
- For the reviewer model and effort, see [model-selection.md](../../../references/model-selection.md): read it when `defaults.models.reviewer` is not set

## Core Principles

- The reviewer owns the review: `esp-reviewer.md` defines the method, the scope (only the diff), the finding format and the severity scale. This skill resolves the diff, runs the reviewer, and parses its reply
- Read-only and routes nothing: the skill writes only into the run or temporary directory, and the caller decides where the review goes (terminal, PR comment, file, CI log)
- Run every script with Bash, with the literal `"${CLAUDE_PLUGIN_ROOT}/scripts/..."` path. Counts, the findings file and the outcome always come from `review.mjs`, never from a hand count

## Skill-Specific Guidelines

### Configuration

Read the `review` section and the shared defaults once at the start:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get review
node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get defaults
```

With the Codex second opinion on, also read `config.mjs get codex`.

If a command exits with code 1 (invalid config), report its error and stop. If it cannot run at all (no `node`), continue with the defaults.

- `review.dimensions` (default `correctness`, `security`, `conventions`, `plan-conformance`): dimensions checked when `--focus` names none
- `review.min_severity` (default `medium`): findings below it are dropped from the review
- `review.verify_findings` (default `true`): run the verify pass; `false` marks the review unverified
- `review.second_opinion` (default `none`): `codex` adds the Codex second opinion when `--second-opinion` is not given
- `codex.model`, `codex.timeout_minutes` (default `null`, `30`): passed to the Codex review; a `null` model passes no `--model`
- `defaults.interactive` (default `off`): interactive mode when `--interactive` is not given
- `defaults.models.reviewer` (default `opus`, effort `high`): model and effort passed to the `esp-reviewer` subagent

The available dimensions are `correctness`, `security`, `plan-conformance`, `tests`, `conventions`, `simplification` and `performance`.

### Scripts

`scripts/review.mjs` resolves the target and parses the review. Every `runs.mjs` call takes `--run-dir <path>`:

- **Resolve target**: `review.mjs target [<target>] --project-dir <repo-root> [--run-dir <path>]` (`<target>`: the `--target` value)
- **Latest plan**: `runs.mjs plan` (`{ path, version }`, version 0 when there is none)
- **Parse and filter**: `review.mjs parse <review_path> --min-severity <level> --verified <bool> --md-out <review_path> --out <findings_path> [--codex <codex_path>]`
- **Codex review** (second opinion only): `codex.mjs review [<target>] --cwd <repo-root> --out <codex_out> --status-path <codex_path> --detach [--model <m>] [--timeout-minutes <n>] [--run-dir <path>]`, then `codex.mjs wait --status-path <codex_path> --max-minutes 9` with a Bash timeout of 600000 ms, repeated while it prints `status: running`
- **Record the step** (under esp-ship, whose run dir has `ship.json`): the same `parse` command piped into `ship.mjs record <step> --run-dir <path>`, which stores its `outcome`

`target` prints `{ kind, base, head, files, untracked, pr, empty, step, diff_path, review_path, findings_path }`. With `--run-dir`, the paths are `<run-dir>/review-<N>.diff`, `.md` and `.json`, where N is the next review round. `parse` prints `{ file, valid, findings, rejected, dropped, outcome }`, where `outcome` is `{ status, summary, max_risk, outputs, discovered_items }`, and exits 1 with the list of malformed findings when the review does not follow the finding format. It strips the reviewer's `Status:` line and keeps its `Discovered:` lines. With `--codex`, it drops a `- Source: codex` finding that repeats a finding of the reviewer at the same file and start line, lists it under Rejected Candidates as a duplicate, and reports the pass in `outputs.second_opinion` (`{ tool, status, summary, candidates, kept, duplicates }`).

### Running the Reviewer

Build one self-contained prompt for the reviewer:

- The diff file (`diff_path`), base and head, the changed files, and the untracked files, which are not in the diff and must be read in full
- For a pull request: its title, URL and description (`gh pr view <n> --json title,body`)
- The dimensions, the focus text, the minimum severity, and whether to verify
- The plan path and the milestone IDs the diff implements (the `done` milestones in `<run-dir>/state.json`, else every milestone), when there is a plan
- The convention files to honor: `AGENTS.md` and `CLAUDE.md` at the repo root and in every ancestor directory of a changed file
- With a `done` Codex result: `codex_path` as the reviewer's **Second opinion** input (see Codex Second Opinion)

Then run it in a fresh context. The choice depends only on the runtime, never on the size of the diff: a small diff still goes to the subagent, because the fresh context keeps the review from being anchored on this session.

- **Subagent available** (the session has a subagent tool and is not itself a subagent): spawn `esp-skills:esp-reviewer` in the foreground with the `model` and `effort` from `defaults.models.reviewer`, and wait for its reply before the next step. With `--run-dir`, record the model with `runs.mjs update --model reviewer=<alias>[:<effort>]` before spawning.
- **Otherwise** (a runtime without subagents, or already inside a subagent): read `agents/esp-reviewer.md` in the plugin root and follow its Methodology and Output Guidance in this session, read-only.

Keep only the reviewer's reply. Save it verbatim to `review_path`.

### Codex Second Opinion

On with `--second-opinion codex` or `review.second_opinion: codex`. Codex runs before the reviewer, so its findings join the reviewer's verify pass instead of bypassing it.

- **Paths**: next to `review_path`, `codex_out` is `review-<N>.codex.md` and `codex_path` is `review-<N>.codex.json`. `codex.mjs` writes the diff it reviewed and its schema beside `codex_out`, and its final result into `codex_path`
- **Run**: start `codex.mjs review` detached on the same `--target` and wait for it (see Scripts). It always runs read-only, with the esp-review finding schema
- **Verify**: when the status is `done`, pass `codex_path` to the reviewer as its Second opinion. `esp-reviewer.md` owns how its candidates are verified and marked
- **Merge**: pass `--codex <codex_path>` to every `review.mjs parse`, which removes the duplicates the reviewer kept and reports the pass
- **Failure**: when Codex ends `failed` (not installed, login, model, timeout), the review continues Claude-only. With `--run-dir`, log it with `runs.mjs decision` (`phase: review`, `source: agent`, `risk: low`, the decision `Continued with a Claude-only review`, the Codex summary as the rationale, `codex_path` in `refs`). The outcome summary then ends with `Codex second opinion failed (...): Claude-only review.`. Suggest `codex.mjs doctor` in the reply

### Interactive Review

In `all` mode, standalone and not headless, after parsing:

1. Show the findings grouped as A, then B-Decide, then B-Scope.
2. For each B-Decide finding, ask which option to apply, with the recommended option first. For each B-Scope finding, ask whether to defer it or keep it in scope.
3. Add a `- Decision: <choice> (user)` line to each answered finding in `review_path`, then parse again. With `--run-dir`, log each answer with `runs.mjs decision`, `source: operator`, `phase: review`, the finding ID in `refs`, and its class as `x-esp-class`.

In every other mode the review settles nothing: the fixer applies the classes with the decision policy.

## Instructions

1. **Parse arguments**: read every option by its short or long name, and resolve the interactive mode per its Definition.
2. **Load configuration** (see Configuration).
3. **Resolve the target**: run `review.mjs target` with the `--target` value. On exit code 2, report the usage error and stop. If `empty` is true, report that there is nothing to review, record it under esp-ship with `ship.mjs record <step> --json '{"status":"done","summary":"Nothing to review: the diff is empty.","max_risk":"low","outputs":{"findings":0}}'`, reply `Status: done` with that summary, and stop.
4. **Resolve the plan**: `--plan`, else with `--run-dir` the path from `runs.mjs plan` when its version is above 0, else none.
5. **Resolve the dimensions**: when every comma-separated item of `--focus` is a dimension name, use those; otherwise use `review.dimensions` and pass `--focus` as the focus text. Remove `plan-conformance` when there is no plan.
6. **Run the Codex second opinion** (when on, see Codex Second Opinion). Done when `codex_path` holds a `done` or `failed` status, and a failure is logged.
7. **Run the reviewer** (see Running the Reviewer). Done when its reply is saved verbatim to `review_path`.
8. **Parse and filter**: run `review.mjs parse` with `--md-out`, `--out` and, with a second opinion, `--codex` (see Scripts). If it exits 1, correct only the reported headings and lines in `review_path` to the finding format, without changing what the findings say, and parse again. If it still fails, end with `Status: failed` and the errors in the summary. When the reviewer replied `Status: failed`, the outcome is `failed` with its summary: end with that reply.
9. **Interactive review** (`all` only, see Interactive Review).
10. **Record the step** (under esp-ship only): run the step 8 `parse` command again, piped into `ship.mjs record <step> --run-dir <path>` (the `step` from `target`).
11. **Report**: print the content of `review_path`, then the reply (see Output Guidance).

## Output Guidance

The review markdown, then the reply of `${CLAUDE_PLUGIN_ROOT}/references/decision-policy.md` (Replies), built from the `outcome` of `parse`:

```markdown
### Review: 3f2a1c0..9b8e7d6

Dimensions: correctness, security, tests. Candidates: 5, verified: 2, rejected: 3.

#### F1 - high - correctness - A

`src/math.js:4-6`: `sum` skips the last element.

- Evidence: the loop runs while `i < xs.length - 1`
- Fix: loop while `i < xs.length` and add a test with three elements

#### F2 - medium - tests - B-Decide

`src/math.js:12`: `divide` has no test for a zero divisor, and its behavior is unspecified.

- Options: throw a `RangeError`; return `Infinity` as today and document it
- Recommended: throw a `RangeError`, which matches `parse()`

#### Rejected Candidates

- `src/math.js:20` missing null check: callers validate input in `src/cli.js:8`
```

```markdown
Status: done
Summary: 2 findings (1 high, 1 medium), 3 candidates rejected. Review: <run-dir>/review-1.md, findings: <run-dir>/review-1.json
```

When nothing survives, the review says `No findings.` and still lists the rejected candidates. `outputs.findings_path` of the outcome points at the parsed findings (`review_format: 1`), which `esp-fix-review --internal` consumes.
