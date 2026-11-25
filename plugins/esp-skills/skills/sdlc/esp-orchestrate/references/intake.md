# Intake

Intake turns the request into the master plan (`<run-dir>/plan.md`) and the task graph (`<run-dir>/graph.json`), then records the graph with `orchestrate.mjs intake --record`. `next` returns `action: intake` until the graph is recorded.

`read the input -> master plan -> size each build unit -> unit plans -> graph file -> intake (validate) -> repositories -> intake --record`

## Inputs

The `[context]` is one of:

- **Prompt**: explore every repository it names (read-only), then write the master plan yourself
- **Task document**: a file with numbered steps, `Depends on:` lines and progress checkboxes. When its steps are usable as they are, copy it as the master plan and only derive the graph: one unit per unchecked step, `depends_on` from its `Depends on:` lines. Checked steps are done: leave them out of the graph and list them in the master plan as done
- **GitHub issue** (URL or `#<number>`): read it with `gh issue view <n> --json title,body,labels` (add `--repo <owner/name>` for another repository), then plan as for a prompt. An issue can name work in several repositories
- **Run directory from esp-plan** (`--run-dir` with a plan): its plan is the master plan source (`runs.mjs plan --run-dir <run-dir>`). Each milestone that lands in its own pull request becomes a unit

When a step of a source document says that someone else opens or merges a pull request, or that a release runs on its own, model it as an `await-pr` or `check` unit, not as a `build`.

## Master Plan

`plan.md` is for the reader and for each unit: the request in one paragraph, the graph (one line per unit: `id`, kind, repository, dependencies), and a short brief per unit (what it changes, why, how it is checked). Draw the graph as an arrow flow, or a Mermaid `graph TD` block when it branches. The master plan is not a plan of the plan format: units with their own plan get a separate file (see Sizing).

## Graph Schema

Write the graph to `<run-dir>/graph.draft.json`. `intake` fills every default, so a unit needs only its kind fields:

- **`id`** (required): letters, digits, dot, underscore or dash, unique. It names the unit run directory `units/<id>/`
- **`kind`** (required): `build`, `adopt`, `await-pr` or `check`
- **`repo`**: `owner/name`. Required for `build`, `adopt` and `await-pr`; a `check` without a repository runs in `cwd`
- **`repo_dir`**: the checkout path; `null` lets intake resolve it (see housekeeping.md)
- **`title`**: one line (defaults to the ID)
- **`depends_on`**: unit IDs that must be `merged` or `done` first. No cycle, no unknown ID
- **`role`**: `code` (default) or `write-back` (see Write-Back)
- **`plan`** (`build` only): `master` or `self` (default), see Sizing
- **`plan_path`** (`build` with `plan: master`): defaults to `<run-dir>/plans/<id>.md`
- **`brief`** (required for `build`): what the unit changes; the task of its esp-ship run when it plans itself
- **`settings`**: `merge` (`auto`, `human`, `none`; defaults to the run's `--merge-policy`), `review` (an `esp-ship --review` mode), `reviewers` (a list), `max_rounds` (defaults to the run's `--max-rounds`), `draft`, `branch` (an existing branch to build on), `checks` (`required` or `none-expected`, for a pull request that runs no checks), `timeout_minutes` (the wait of a `check` or `await-pr`)
- **`pr`** (required for `adopt`): the URL of an open pull request of `repo`
- **`match`** (`await-pr`): `head` or `author` (one is required), and optional `base` and `title` (a regular expression). Only an open pull request matches, so a closed or merged one on a reused head branch is never adopted
- **`command`** (required for `check`): a shell command that exits 0 once the condition holds; **`cwd`**: where it runs (defaults to the unit checkout)

### Example

A library publishes shared presets through a release bot, then an app switches to them on an existing branch, and the task document gets its checkboxes ticked:

```json
{
  "graph_format": 1,
  "units": [
    {
      "id": "lib-presets",
      "kind": "adopt",
      "title": "Shared presets and their changeset",
      "repo": "acme/lib",
      "pr": "https://github.com/acme/lib/pull/12"
    },
    {
      "id": "lib-version",
      "kind": "await-pr",
      "title": "Version packages pull request",
      "repo": "acme/lib",
      "depends_on": ["lib-presets"],
      "match": { "head": "changeset-release/main", "base": "main" },
      "settings": { "checks": "none-expected" }
    },
    {
      "id": "lib-release",
      "kind": "check",
      "title": "Release workflow published 0.1.0",
      "repo": "acme/lib",
      "depends_on": ["lib-version"],
      "command": "npm view @acme/presets@0.1.0 version",
      "settings": { "timeout_minutes": 30 }
    },
    {
      "id": "app-presets",
      "kind": "build",
      "title": "App consumes the published presets",
      "repo": "acme/app",
      "depends_on": ["lib-release"],
      "plan": "master",
      "brief": "Replace the local theme constants with @acme/presets 0.1.0",
      "settings": { "branch": "feature/shared-presets" }
    },
    {
      "id": "write-back",
      "kind": "build",
      "role": "write-back",
      "title": "Tick the task document",
      "repo": "acme/docs",
      "depends_on": ["app-presets"],
      "plan": "master",
      "brief": "Tick the shared presets steps and add the pull request links"
    }
  ]
}
```

`orchestrate.mjs intake --graph <file>` prints `{ units, order, unresolved, decisions }` and writes nothing; it exits 1 with every error listed (duplicate IDs, unknown kinds or dependencies, cycles, a missing kind field, a bad setting). With `--record`, it writes `graph.json`, sets every unit `pending`, moves the run to the approve phase (the run phase with `-i off`) and logs one decision per sizing choice and per merge policy other than `auto`. A graph is recorded again only while every unit is still `pending`.

## Sizing

Size each `build` unit, and log nothing yourself: `intake --record` logs each choice.

- **Small** (`plan: master`): the change fits the esp-ship inline limits (one concern, about `ship.inline.max_files_changed` files or fewer, no open design choice). Write its full plan to `plans/<id>.md`: a plan in the plan format (`plan.mjs lint <file>` passes), or the step of the source document copied as it is. The unit runs `esp-ship --plan-mode skip` with that file, so it plans nothing
- **Large** (`plan: self`): the master plan holds only the brief, and the unit's esp-ship run plans itself from it

`adopt`, `await-pr` and `check` units have no plan.

## Merge Policy

Prefer `auto`. A source document that says someone else merges a pull request does not switch the unit to `human` or `none` on its own: keep `auto` and log the choice with `runs.mjs decision` (`phase: intake`, `source: agent`, the document line in `rationale`, `human` in `alternatives`). Only the request (`--merge-policy`, or the request text naming a unit) or the answer at the plan approval sets `human` or `none` on a unit.

## Write-Back

When the input is a task document and write-back is on (`settings.write_back` of `orchestrate.mjs show`, off with `--no-write-back`), add a final `build` unit with `role: write-back` in the repository of the document: tick the checkboxes of the steps this run delivers, set each step's status, and add the pull request links. It depends, directly or not, on every code unit, and its brief names the document path. Follow that repository's rules on where local IDs may appear (its `AGENTS.md` or `CLAUDE.md`).

When a code unit in the document's repository runs last (it depends, directly or not, on every other unit), put the write-back in that unit's brief instead of adding a unit: the edit goes into its pull request.

A prompt, an issue or an esp-plan run has no document to write back: add no write-back unit.
