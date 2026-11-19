# Run Directory

A run directory holds what one esp-skills run did: its status, its plan, the decisions it made and its outcome. `esp-recap`, resume and the pull request body read it back. Skills never write its JSON files by hand: they call `scripts/runs.mjs`, which checks the fields it needs before every write:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs" <command> --run-dir <path> [options]
```

## Location

- **Standalone run**: the top-level skill (for example `esp-ship`) runs `runs.mjs create <slug>`, which creates `<runs.root>/<YYYY-MM-DD>-<slug>` (a `-2`, `-3` suffix when the name is taken) and owns the run
- **Child skill**: the owner passes `--run-dir <path>` to the skills it calls (esp-plan, esp-review, esp-fix-review, esp-merge, esp-pr). `runs.mjs create --run-dir` finds the existing `run.json` and leaves it alone, so a child never assumes whether it owns the run
- **Index**: `runs.mjs index` lists the runs under every root (`--root`, else `recap.roots` and `runs.root`), filtered by `--since`, `--until`, `--last`, `--repo`, `--status`, `--workflow` (the run owner, for example `esp-ralph` for a ralph loop) and `--risk`, with dates read from the directory names

## Files

| File                      | Written by                                                                     | Content                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.json`                | `runs.mjs create`, `update`; `decision` and `ship.mjs record` raise `max_risk` | ID, type, title, owning workflow or skill, repository, base, branch, worktree, PR, status, `max_risk`, `started_at`, `updated_at`, `ended_at`, models, budgets used |
| `decisions.jsonl`         | `runs.mjs decision`, and the scripts that log their own choices                | One decision per line, append-only                                                                                                                                  |
| `plan.md`, `plan.v<N>.md` | esp-plan                                                                       | The plan (format 1, see [plan-format.md](./plan-format.md)); each amendment is a new version, logged as one decision                                                |
| `ship.json`               | `ship.mjs` only                                                                | esp-ship state: track, phases, workspace, review gate, final gates, frozen config and the `steps` list (`ship.mjs record <step>`)                                   |
| `state.json`              | `ship.mjs milestone` only                                                      | Milestone loop state of the orchestrated track, including the last verifier failures for a retry                                                                    |
| `triage.json`             | `ship.mjs triage --record`                                                     | Detected input kind, plan source and track                                                                                                                          |
| `notes.md`                | `runs.mjs notes --append`                                                      | Shared run notes and operator lines (see Notes)                                                                                                                     |
| Review files              | esp-review, esp-fix-review                                                     | Review findings and `fix-review.json` (handled comment IDs)                                                                                                         |
| `summary.md`              | The owning skill, per [summary-template.md](./summary-template.md)             | Flat frontmatter and the run summary                                                                                                                                |

## Field Checks

The writers check only what readers rely on; unknown fields are allowed, so a writer can add one without changing the checks (`scripts/lib/run-files.mjs`):

- **`run.json`**: `id`, `type` (`skill` or `workflow`), `status` and `started_at` are required. `status` is one of `queued`, `running`, `paused`, `blocked`, `awaiting-human`, `halted`, `failed`, `canceled`, `done`, `merged`; `runs.mjs update` sets `ended_at` on the last five
- **Decision**: `id` (`D001`, `D002`, ... filled when missing), `at` (filled), `phase`, `source` (`agent`, `operator` or `policy`), `risk` (`low`, `medium`, `high`), `decision` and `rationale` are required; `alternatives`, `files` and `refs` are string lists, `commit` a SHA or null. esp-skills adds `x-esp-*` fields: `x-esp-class` (finding class), `x-esp-estimate` (triage file estimate), `x-esp-review-gate` (diff numbers), `x-esp-builder-reuse` (agent ID, model, tokens), `x-esp-escalation` (track switch trigger)
- **`summary.md` frontmatter**: `task`, `title` and `status` are required; `decisions`, `critical_findings` and `duration_minutes` are numbers

`runs.mjs check <file>` runs the same checks on a `run.json`, `decisions.jsonl` or `summary.md` (`--kind run|decision|summary` when the file name does not tell) and prints each error with its line and field.

## Notes

`notes.md` carries what one worker learned to the next one, and the user's corrections:

- **Agent line**: `- **<milestone>**: <text>`, appended with `runs.mjs notes --append <text> --milestone <id>`
- **Run-wide line**: `- **run**: <text>`, appended without `--milestone` (for example by a loop iteration)
- **Operator line**: `- **<scope>** (operator): <text>`, appended with `--from operator` by the session that received the user's message during a run. The next worker reads it first and applies it
- **Reading**: `runs.mjs notes --show [--milestone <id>]` includes the run-wide lines. Verifiers never read the notes, and the file is never committed

## Append Lock

Writers of `decisions.jsonl`, `notes.md` and `run.json` hold a lock file next to the target (`<file>.lock`, created with exclusive create, removed after the write; a lock older than 30 seconds is stale). Under the lock, the writer reads the line count, builds the entry (the next ID), checks it and appends one line. This keeps lines whole and IDs unique when several processes write to the same run. In a jsonl file, blank lines are only allowed at the end; `runs.mjs check` reports any other blank line.

## Script Help

- `scripts/runs.mjs --help`: every run directory command and option
- `scripts/ship.mjs --help`: esp-ship triage, tracks, phases, milestone state, gates, review and PR loops, step records and outcome
- `scripts/review.mjs --help`, `scripts/fix-review.mjs --help`, `scripts/wait-for-review.mjs --help`, `scripts/merge-ready.mjs --help`: the review, fix-review, wait and merge steps
- `scripts/recap.mjs --help`: esp-recap run selection, digests, risk report and Q&A sources
- `scripts/plan.mjs --help`: plan parsing, lint and amendment checks
- `scripts/gates.mjs --help`: the gate commands of a project (configured or detected) and the checks of a scope, with or without a run
- `scripts/config.mjs --help`: the config layers, and `--run-dir` for the frozen snapshot of a run
