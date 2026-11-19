# Workspace

Where the task works: the branch and the working directory. `ship.mjs workspace` picks one of three workspaces and records it in `ship.json` (`workspace`):

- **`checkout`**: a new branch in the main checkout
- **`existing-branch`**: a branch that already exists, checked out as is: `--branch <name>` (local, or tracked from `origin`), or the current branch when it is not the base or the default branch and the main checkout is clean (`from_current: true`)
- **`worktree`**: a task worktree under `worktrees.root`, with `--worktree` (or `ship.worktree`), or because the main checkout is dirty. Without `--branch`, a dirty tree always gets a new branch, even on a feature branch: the current branch stays checked out in the main checkout with its changes

## Dirty Tree

A dirty main checkout (`git status --porcelain` prints something) does not stop the run. With `ship.dirty_tree: worktree` (the default), the task runs in a task worktree and the dirty files stay untouched in the main checkout. `workspace` logs it as a `policy` decision that names the dirty files. With `ship.dirty_tree: fail`, `workspace` exits 1: report it and stop with `status: failed`.

A dirty tree with `--branch` naming the current branch always fails: the task work would mix with the uncommitted changes. The preflight checks it before the run starts.

## Branch Phase

`next` returns `phase: branch` with `cwd`. Record `phase branch --status started`, then run `ship.mjs workspace`, with `--branch <name>` when the operator gave `--branch`. Act on its `action`:

- **`use`**, **`checkout`**, **`create`**, **`worktree`**: the branch is ready, and `workspace` recorded `branch`, `base_sha` and, for a worktree, the working directory. `base_sha` is the merge-base with `origin/<base>` for an existing branch, and the start commit for a new one
- **`name-branch`**: the task needs a new branch. Build its name (see Branch Name), then run `ship.mjs workspace --branch <name>` again. It creates the branch from `origin/<base>`, in the main checkout or in the task worktree

When `workspace` ran without `--branch` and returned `existing-branch` with `from_current: true`, check the current branch for an open pull request before building on it (see Open Pull Request). Then record `phase branch --status done`. Errors (exit 1) end the task with `ship.mjs stop --status failed --reason <error>`.

`workspace` is idempotent: once the branch is recorded, for example after a track switch or a resume, it returns `action: use` with the recorded workspace and `cwd`, and changes nothing. The one exception is `--new-branch` (see Open Pull Request).

### Branch Name

Read the `branch` section once (`config.mjs get branch --run-dir <run-dir>`, the run's frozen config) and fill its pattern:

- **Pattern**: `branch.pattern` (`{category}/{issue}_{name}`) when an issue number is known (the request is a GitHub issue, or the plan names one), else `branch.pattern_without_issue` (`{category}/{name}`)
- **`{category}`**: from the plan `type` on the orchestrated track, else from your judgment of the request on the inline track, mapped to `branch.categories`: `feature` -> `feature`, `bug` -> `fix`, `chore` -> `chore`. Any other type, or a category not in `branch.categories`, takes `branch.default_category` (`feature`)
- **`{issue}`**: the issue number
- **`{name}`**: a slug of the plan title or the request, lowercase kebab-case, three to five words (every run of non-alphanumeric characters becomes one hyphen, with no leading or trailing hyphen)

For example, a `bug` plan titled "Fix the token refresh race" for issue `#42` gives `fix/42_fix-token-refresh-race`.

### Open Pull Request

The current branch may already carry an open pull request, which the task would then land on. Run `gh pr list --head <branch> --state open --json url`. With no pull request, continue. With one:

- **`plan` or `all` mode**: ask. Continuing on that branch is the recommended option only when the request is about that pull request (it names it, or continues its work). Otherwise recommend a new branch. Log the answer with `runs.mjs decision` (`source: operator`)
- **`off` mode**: log a `policy` decision (`risk: medium`) that names the pull request, and continue on the branch

For a new branch, run `ship.mjs workspace --new-branch`: it drops the reused branch (nothing changed in git) and returns `name-branch`. Then name the branch and run `workspace --branch <name>` as above.

## Task Worktree

In a worktree workspace, `next` returns the worktree path as `cwd` from then on: every phase works there, and the main checkout stays untouched. `ship.mjs worktree --branch <name> [--from <ref>]` still creates a worktree directly, on a new branch from `origin/<base>` (or `--from`), when a caller needs one outside the branch phase. `esp-merge` removes the worktree after the merge per `worktrees.cleanup`.
