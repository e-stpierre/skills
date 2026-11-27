# Repositories, Waits and Housekeeping

Everything this session runs itself, outside the units: resolving and checking the repositories before the run, the waits of `check` and `await-pr` units, and the git housekeeping after each merge.

## Repositories

Each unit names its repository as `owner/name`. `orchestrate.mjs intake` resolves the checkout of each one, in order:

1. `repo_dir` given in the graph file
2. `orchestrate.repos` (`owner/name` -> path) of the frozen config
3. The repository of `--project-dir`, or a sibling directory of it, whose `origin` URL names `owner/name` (HTTPS or SSH)

A repository it cannot resolve is listed in `unresolved`, with `repo_dir: null`. Resolve it before `intake --record`:

- **`-i plan` or `all`**: ask for the path of a checkout, or offer to clone it
- **`-i off`**: clone it under `worktrees.root`: `gh repo clone <owner/name> <worktrees.root>/<name>`, and log the clone with `runs.mjs decision` (`source: agent`)

Then set its `repo_dir` in the graph file. To make the mapping permanent, the user adds it to `orchestrate.repos` with esp-config.

### Preflight

For every repository of the graph, once its checkout is known:

- **Git checkout**: `git -C <repo_dir> rev-parse --show-toplevel` succeeds, and `git -C <repo_dir> remote get-url origin` names the unit's `owner/name`
- **GitHub access**: `gh repo view <owner/name> --json name` succeeds
- **Allowed directories**: the checkout is the session's working directory, or inside a directory added with `/add-dir` or `permissions.additionalDirectories`. Otherwise every edit of a unit in it prompts for permission: tell the user (with the `/add-dir <repo_dir>` command) before the first unit starts, and log it as a decision. It does not stop the run
- **Tokens**: each token the master plan names (for example a registry token for a `check` against a private registry) is set in the environment. Check that it is set without printing it (`test -n "$NAME"`)

A failed check other than the allowed directories stops the run before any unit starts: report each failure and end with `status: failed`. In `plan` or `all` mode, ask first whether to fix it and retry.

A dirty checkout does not fail the preflight: esp-ship moves the unit to a task worktree, and housekeeping leaves that checkout alone.

## Waits

A `check` unit, and an `await-pr` unit with no pull request yet, run as a wait. `next` returns `start-wait` with `unit`, `wait` (`command` or `pr`), `restart`, `state_file` (`<run-dir>/waits/<id>.json`), and `command`, the full `wait-for.mjs` line:

- **`wait-for.mjs command --run <cmd> [--cwd <dir>]`**: runs the shell command until it exits 0
- **`wait-for.mjs pr --repo <owner/name> (--head <branch> | --author <login>) [--base <branch>] [--title <regex>]`**: polls the pull requests of the repository until one matches

Both take `--state <file>`, `--run-dir <run-dir>` (the poll interval and the timeout from the frozen `orchestrate.wait` config), and `--timeout-minutes <n>` when the unit sets `timeout_minutes`.

1. Run `orchestrate.mjs wait start <id>`: the unit becomes `waiting`, and it prints the same `command`
2. Run the command in the background with an exit notification, its output redirected to `<run-dir>/waits/<id>.out` (`mkdir -p <run-dir>/waits && <command> > <run-dir>/waits/<id>.out 2>&1`), with a shell timeout above the wait timeout when the runtime takes one. Then run `next` again: other units can start while it waits
3. On the exit notification, run `orchestrate.mjs wait record <id> --result <run-dir>/waits/<id>.out`. It reads the last JSON line, `{ status, summary, outputs }`:
   - **`done`**: a `check` ends `done`. An `await-pr` keeps the pull request it found (`outputs.pr`) and goes back to `pending`, ready to adopt
   - **`awaiting-human`**: the deadline passed with the condition unmet. The unit stops `awaiting-human` and blocks its dependents. A resume restarts it with a new deadline
   - **`failed`**: the command could not run, or `gh` kept failing. The unit stops `failed`
4. When the output holds no JSON line (a usage error, exit 2), run `unit failed <id> --reason <the error line>`

The state file keeps the deadline: a wait that is interrupted (the shell killed it, the session ended) and started again with the same state file keeps its first deadline, and `restart: true` from `next` after `orchestrate.mjs resume` reuses it. Without background execution, run the command in the foreground with the longest shell timeout, and rerun it when the shell kills it first. Never poll a wait from this session: its exit notification wakes the session.

## Housekeeping

After a unit merges, `next` returns `housekeep` for it once no other unit runs in that checkout, unless the run has `--no-housekeeping`. The action carries `repo_dir`, `base` and `branch` from the unit's `ship.json`, `pr`, `rebase` (the branches of later `build` units of the same checkout that have not started) and `command`, the full `housekeep.mjs run` line:

```bash
node "../../../../scripts/housekeep.mjs" run --repo-dir <repo_dir> --base <base> --branch <branch> --pr <url> --worktree <path> --rebase <branch>
```

Run the `command` in the foreground (it only runs git and one `gh pr view`), with its output saved to `<run-dir>/housekeep/<id>.json` (create the directory first), then `orchestrate.mjs housekeep --unit <id> --result <run-dir>/housekeep/<id>.json`. With `skip` in the action (no base known, `args: null`), run nothing and record `--result '{"status": "skipped", "summary": "<skip>"}'`. When the script prints no JSON (a usage error), record `{"status": "failed", "summary": "<the error line>"}`.

The steps, each guarded so that nothing unmerged or foreign is lost:

1. **Dirty checkout**: `git status --porcelain` lists changes. Nothing changes: `status: skipped`, `reason: dirty`, with the files. The summary names the checkout
2. **Base**: `git fetch origin <base>`, switch to `<base>`, `git merge --ff-only origin/<base>`. A base with local commits is reported (`diverged`), never forced
3. **Worktrees**: each `--worktree` is removed with `git worktree remove` (no `--force`), only when it is a linked worktree of this repository under `worktrees.root`. A dirty or foreign worktree is kept and reported
4. **Branch**: the local task branch is deleted with `git branch -D` only when `gh pr view` reports its pull request `MERGED` with that head branch, its local tip is the pull request head commit or an ancestor of it (local commits that never reached the pull request keep the branch), and the branch is not checked out in another worktree. Never `git branch --merged`, which misses squash merges
5. **Rebase**: each `--rebase` branch is rebased with `git rebase origin/<base> <branch>`. A conflict is aborted (`conflict`) and reported. esp-ship reruns that unit's gates when its pull request opens (base sync)

Nothing is ever pushed. The result is `done`, `skipped`, `partial` (something kept, diverged or conflicting) or `failed`; `orchestrate.mjs housekeep` records it on the unit, with the rebased branches on the later units. `outcome` lists the dirty checkouts (`dirty`) and the other issues (`housekeeping_issues`) for the summary.

## Known Risks

- **Required checks on bot pull requests**: when the base branch requires checks, a pull request opened with `GITHUB_TOKEN` (a release bot's version pull request) never starts them and cannot merge. Not handled: the unit ends `awaiting-human` with the blocking condition from esp-merge, and the report names it. Known fixes, outside this run: a GitHub App token or a personal access token in the release workflow, or an empty commit pushed with the user's credentials to start the checks. For a pull request that runs no checks at all, set `checks: none-expected` on the unit
- **Wait timeouts**: a wait past its deadline stops the unit `awaiting-human`, never `failed`: the condition may still come true. Raise `timeout_minutes` on the unit for a slow release
