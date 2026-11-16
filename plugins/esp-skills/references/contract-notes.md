# Harness Contract Notes

How esp-skills implements harness contract v1. agentic-forge owns the contract: the spec is its `docs/harness-contract.md`, and the JSON Schemas and fixtures are published in its `schemas/contract-v1/`. [`contract/v1/`](./contract/v1/) is a byte-identical copy of that directory. esp-skills re-syncs the copy from agentic-forge and never changes it on its own.

Skills never write contract files by hand. They call `scripts/runs.mjs`, which validates every artifact against the schemas before writing it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs" <command> --run-dir <path> [options]
```

## Contract Artifacts

| Artifact            | Schema                            | File in a run dir                |
| ------------------- | --------------------------------- | -------------------------------- |
| Run metadata        | `run.schema.json`                 | `run.json`                       |
| Decision            | `decision.schema.json`            | one line of `decisions.jsonl`    |
| Summary frontmatter | `summary-frontmatter.schema.json` | YAML frontmatter of `summary.md` |
| Shared definitions  | `common.schema.json`              | none (referenced by the others)  |

Schemas use `urn:harness-contract:v1:<artifact>` as `$id` and reference each other by that URN, so they can be copied unchanged into another repository. Each artifact has `fixtures/<artifact>/valid/` and `fixtures/<artifact>/invalid/` examples. Fixtures named `*-by-runs-mjs.json` are golden files: the tests check that `runs.mjs` produces exactly them.

Extension fields are allowed on most artifacts when they start with `x-` (for example `x-esp-class` on a decision). Any other unknown field is invalid.

## Requirements and Where They Are Met

| Contract requirement                                                                                                                                                              | Met by                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run directory named `YYYY-MM-DD-<slug>` under the runs root                                                                                                                       | `runs.mjs create <slug>` (root: `--root`, else `runs.root`)                                                                                                                                          |
| Use the run dir passed by a harness or parent run                                                                                                                                 | `runs.mjs create --run-dir <path>` (reuses an existing run)                                                                                                                                          |
| `run.json` with contract fields and status                                                                                                                                        | `runs.mjs create`, `runs.mjs update --status ...`                                                                                                                                                    |
| `ended_at` set on terminal statuses                                                                                                                                               | `runs.mjs update --status halted\|failed\|canceled\|done\|merged`                                                                                                                                    |
| `max_risk` is the highest recorded risk                                                                                                                                           | `runs.mjs decision`, `ship.mjs record` and `update --max-risk` raise it                                                                                                                              |
| Step facts recorded in `ship.json`, replies in markdown                                                                                                                           | `ship.mjs record <step>` (the `steps` list), the Replies format of `decision-policy.md`                                                                                                              |
| `decisions.jsonl` appended when the decision is made                                                                                                                              | `runs.mjs decision` (fills `id` as `D001`... and `at`)                                                                                                                                               |
| Amendments as `plan.vN.md`, each logged as one decision                                                                                                                           | `runs.mjs decision`, `runs.mjs plan` (latest version)                                                                                                                                                |
| Later steps read the latest plan version                                                                                                                                          | `runs.mjs plan`                                                                                                                                                                                      |
| Plans parse without a model; amendments keep completed milestones                                                                                                                 | `plan.mjs parse`, `plan.mjs lint`, `plan.mjs diff` (`references/plan-format.md`)                                                                                                                     |
| Milestone loop state (`state.json`, reserved name)                                                                                                                                | `ship.mjs milestone init`, `next`, `start`, `finish`                                                                                                                                                 |
| Review outcome built from the findings, not by hand                                                                                                                               | `review.mjs parse` piped into `ship.mjs record review-<N>` (esp-review)                                                                                                                              |
| Waiting costs no tokens; reviews and checks matched on the head SHA                                                                                                               | `wait-for-review.mjs --checks` in the background, piped into `ship.mjs record fix-review-wait` (esp-ship); esp-fix-review `--wait` keeps the wait inside its `fix-review` step                       |
| Every review comment resolution logged; handled comments never reprocessed                                                                                                        | `fix-review.mjs record` (decision + `fix-review.json` handled IDs), `fix-review.mjs outcome` piped into `ship.mjs record fix-review` (esp-fix-review)                                                |
| Merge only under objective conditions; method and reason logged; checked again right before the merge                                                                             | `merge-ready.mjs check` (conditions), `merge-ready.mjs merge` (checks again, logs the decision), piped into `ship.mjs record merge` (esp-merge)                                                      |
| A task owns its run: triage, inline or orchestrated track, phase dispatch with subagents, bounded internal review and PR rounds, resume, track switch, PR body from run artifacts | `ship.mjs triage --record`, `init`, `next`, `phase`, `review-gate`, `final-gates`, `pr-loop`, `switch-track`, `stop`, `halt`, `record`, `pr-body`, `outcome` (esp-ship); `runs.mjs pr-body` (esp-pr) |
| `summary.md` frontmatter per the schema                                                                                                                                           | `references/summary-template.md`, `runs.mjs validate summary.md`                                                                                                                                     |
| Date filtering without file reads, other filters from `run.json`                                                                                                                  | `runs.mjs index --since --until --last --repo --status --risk`                                                                                                                                       |
| Any contract file can be checked                                                                                                                                                  | `runs.mjs validate <file>`                                                                                                                                                                           |

## esp-ship Run Files

Besides the contract artifacts, an esp-ship run dir holds files that only esp-skills reads. They are not part of contract v1, and their schemas are not published:

- **`ship.json`**: the esp-ship state (track, phases, workspace, review gate, final gates), written only by `ship.mjs`
- **`state.json`**: the milestone loop state of the orchestrated track (reserved name), written only by `ship.mjs milestone`
- **`triage.json`**: `ship.mjs triage --record` writes the detected input kind, plan source and track, and logs one decision per choice (`source`: `operator` for a flag, `policy` for a rule, `agent` for the model's judgment)
- **`notes.md`**: shared run notes. Builders read them with `runs.mjs notes --show` and append facts with `runs.mjs notes --append <text> --milestone <id>`, under the append lock. A user correction is appended with `--from operator` (marked `(operator)` on the line), and a line without `--milestone` applies to the whole run. Verifiers never read them. The file is never committed
- **Decision extensions**: `x-esp-estimate` (triage file estimate), `x-esp-review-gate` (diff numbers of the review gate), `x-esp-builder-reuse` (agent ID, model, used and limit tokens of a builder reuse decision), `x-esp-escalation` (track switch or escalation trigger)

## Append Protocol

Writers of `decisions.jsonl`, `notes.md` and `run.json` hold a lock file next to the target (`<file>.lock`, created with exclusive create, removed after the write; a lock older than 30 seconds is stale). Under the lock, the writer reads the line count, builds the entry (the next ID), validates it and appends one line. This keeps lines whole and IDs unique when several processes write to the same run. In a jsonl file, blank lines are only allowed at the end; `runs.mjs validate` reports any other blank line.

## Standalone and Harness Runs

- **Standalone**: the top-level skill (for example `esp-ship`) runs `runs.mjs create <slug>` and owns the run. It passes `--run-dir` to the skills it calls, which then write decisions and step records into the same directory.
- **Harness**: the harness creates the run dir and passes `--run-dir <path>`. `runs.mjs create --run-dir` finds the existing `run.json` and leaves it alone.
- Skills never assume which of the two they are in.

## Compliance Levels

| Level      | Requirements                                              |
| ---------- | --------------------------------------------------------- |
| Plain      | None. Runs as a step                                      |
| Reporting  | Ends with a markdown reply and writes `run.json` fields   |
| Steerable  | Reporting, plus reads the operator lines of `notes.md`    |
| Recappable | Steerable, plus writes `decisions.jsonl` and `summary.md` |

Skills no longer declare a level in their frontmatter.

## References

- [`contract/v1/`](./contract/v1/): schemas and fixtures
- `scripts/runs.mjs --help`: every command and option
- `scripts/review.mjs --help`: esp-review target resolution and finding parsing
- `scripts/wait-for-review.mjs --help`: the review and check wait of esp-fix-review `--wait` and esp-ship, completion matching and exit codes
- `scripts/fix-review.mjs --help`: esp-fix-review items, rounds, resolutions and replies
- `scripts/ship.mjs --help`: esp-ship triage, tracks, phase dispatch, milestone state (`state.json`), builder reuse, gates, review and PR loops, workspace, track switch, PR body and result
- `scripts/recap.mjs --help`: esp-recap run selection, digests, risk report and Q&A sources
- `scripts/merge-ready.mjs --help`: esp-merge conditions, method resolution and the final re-check
- `scripts/plan.mjs --help` and [`plan-format.md`](./plan-format.md): plan format 1, parsing, lint and amendment checks
- `scripts/lib/contract.mjs`: status vocabulary, exit codes and schema loading for other scripts
