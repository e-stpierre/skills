# Merge Script Behavior

What `scripts/merge-ready.mjs` decides on its own. The skill takes these decisions from the script output as they are: read this file to explain a method choice to the user.

## Method Resolution

An explicit method (`--method`, or `merge.method` other than `repo`) is used as given, and errors if the repository does not allow it. With `merge.method: repo`, the script resolves the method:

1. Read the allowed methods (`squashMergeAllowed`, `rebaseMergeAllowed`, `mergeCommitAllowed`), the branch rulesets (allowed merge methods, `required_linear_history`, `merge_queue`) and the classic branch protection (linear history), when readable.
2. A merge queue on the base branch: enqueue (`--auto`), and the queue decides.
3. One method allowed: use it.
4. Several: the first allowed in `merge.preference`, excluding `merge` under linear history.

Either way, the method and the reason are logged as a decision (`phase: merge`) with `--run-dir`.
