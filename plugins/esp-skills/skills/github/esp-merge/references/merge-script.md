# Merge Script Behavior

What `scripts/merge-ready.mjs` decides on its own. The skill takes these decisions from the script output as they are: read this file to explain a method choice to the user.

## Method Resolution

An explicit method (`--method`, or `merge.method` other than `repo`) is used as given, and errors if the repository does not allow it. With `merge.method: repo`, the script resolves the method:

1. Read the allowed methods (`squashMergeAllowed`, `rebaseMergeAllowed`, `mergeCommitAllowed`), the branch rulesets (allowed merge methods, `required_linear_history`, `merge_queue`) and the classic branch protection (linear history), when readable.
2. A merge queue on the base branch: enqueue (`--auto`), and the queue decides.
3. One method allowed: use it.
4. Several: the first allowed in `merge.preference`, excluding `merge` under linear history.

Either way, the method and the reason are logged as a decision (`phase: merge`) with `--run-dir`.

## Checks Mode

`check` and `merge` take `--checks required|none-expected` (default `required`); any other value is a usage error (exit 2).

- `required`: checks register a short time after a push, so an open pull request with no checks on a head committed within `fix-review.wait.checks_grace_seconds` (default 120) reports the checks condition `pending`, with `(not registered yet)`
- `none-expected`: the pull request runs no checks (for example one opened with `GITHUB_TOKEN`, which triggers no workflows). The grace period is skipped, so no checks passes at once. Checks that do exist still count: a failing check fails the condition, a pending one keeps it pending

## Waiting for a Human Merge

`wait-merge [pr] [--wait-minutes <n>] [--poll-seconds <n>] [--run-dir <path>]` never merges: it waits for someone else to merge or close the pull request. It polls the pull request state every `--poll-seconds` (default `merge.poll_seconds`) up to the deadline, `--wait-minutes` after the first call (default `merge.human_wait_minutes`), and prints `{ status, summary, outputs }`:

- `merged`: the pull request was merged; `outputs.merge_commit` is the merge commit
- `failed` (exit 1): the pull request was closed without merging (`outputs.reason: closed`)
- `awaiting-human`: still open at the deadline (`outputs.timed_out: true`)

`outputs` also carries `pr`, `url`, `state`, `deadline` and `polls`, so the block can be recorded as is with `ship.mjs record merge`. With `--run-dir`, the deadline is kept in `<run-dir>/merge-wait.json`: a rerun on the same pull request keeps the first deadline, whatever its `--wait-minutes`, so a wait run in slices (or resumed after an interruption) still ends on time. Delete the file to start a new deadline; a different pull request starts one on its own.
