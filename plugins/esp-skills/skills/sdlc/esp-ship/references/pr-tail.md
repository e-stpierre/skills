# Pull Request Tail

The phases both tracks share once the work is committed: `pr`, `fix-review` and `merge`. Each fix round starts with a wait for the reviews and the CI checks of the head commit, run by this session as step `fix-review-wait` of the `fix-review` phase. `--no-pr` drops the tail, and `--no-merge` drops the merge.

## Pull Request

`next` returns `phase: pr` with `draft`: `true` when the run was started with `--draft`, else `pr.draft`. The pull request opens as a draft or ready from the start, and esp-ship never changes it.

1. `phase pr --status started`.
2. Spawn the `mechanical` phase subagent on `skills/git/esp-pr/SKILL.md` with `--base <base> --run-dir <run-dir>` (add `--draft` when `next.draft`). esp-pr pushes the branch itself, and with `pr.body_from_run` it builds the body from the run artifacts. On the inline track, this session may do the same steps itself instead of spawning: `git push -u origin <branch>`, `ship.mjs pr-body --out <run-dir>/pr-body.md`, then `gh pr create --base <base> --title "<title>" --body-file <run-dir>/pr-body.md` (add `--draft` when `next.draft`). `ship.mjs pr-body` renders the same body as the `runs.mjs pr-body` that esp-pr runs, from the config frozen in `ship.json`, with the plan overview or the request as the default summary.
3. `phase pr --status done --pr <url>`, with the URL from the `Summary:` of the esp-pr reply (or from `gh pr create`).

## Review and Checks Wait

`next` returns `phase: fix-review` with `rounds` (the cumulative round number), `wait_step: fix-review-wait` and `wait_checks: true`. The wait runs in this session: the wait script wakes it on exit, so the wait costs no tokens and no subagent sleeps through it.

1. `phase fix-review --status started` (first round only).
2. Start the wait: `node "${CLAUDE_PLUGIN_ROOT}/scripts/wait-for-review.mjs" <pr url> --checks --reviewers <names> --run-dir <run-dir>` (leave `--reviewers` out when none were given: the script uses `fix-review.wait.default_reviewers`). The script posts trigger comments itself when `fix-review.wait.auto_trigger` is on, keeps its clock in `<run-dir>/fix-review-wait.json`, and is done when every reviewer reviewed the head commit and no check is pending. Run it in the background with an exit notification when the runtime has it (with a shell timeout above `fix-review.wait.timeout_minutes`), and end the turn: the next action is reading the exit notification. Without background execution, run it in the foreground with the longest shell timeout. If the shell kills it first, run the same command again: the state file keeps the clock, so the total wait still honors the timeout.
3. Record the wait: pipe its output into `ship.mjs record fix-review-wait --run-dir <run-dir>`. Read its `status`, not the exit code: a timeout is `awaiting-human` with exit 0.
4. `ship.mjs pr-loop --after wait`:
   - **`fix`**: run a fix round. `failing_checks` names the checks that failed on the head. With `timed_out: true`, log a B-Decide decision: the comments and checks that arrived are fixed without waiting longer
   - **`stop`**: the task ends (the stop is recorded), for example on a closed pull request

## Fix Rounds

1. In `all` mode, run the before-round checkpoint (below).
2. Spawn the `fixer` phase subagent on `skills/github/esp-fix-review/SKILL.md` with `--max-rounds <round> --pr <pr url>` (`round` from the `fix` action of `pr-loop --after wait`, and `--reviewers <names>` when given), without `--wait`: this session already waited. One round per spawn, so the subagent never waits for a re-review itself. It fixes the comments and the failing checks of the head in the same round. In `all` mode, put the checkpoint answers in `<extra context>`.
3. `ship.mjs pr-loop --after fix`:
   - **`wait`**: the round pushed commits and rounds are left. Wait again (Review and Checks Wait, step 2), then run the next fix round
   - **`merge`**: record `phase fix-review --status done`
   - **`stop`**: the task ends, for example with review items left open (`awaiting-human`, the pull request left open)
4. In `all` mode, run the after-round checkpoint (see Interactive Checkpoints in SKILL.md).

### Before-Round Checkpoint

Only in `all` mode, before each fix round. This session shows the round and asks, so the fixer subagent applies answers instead of the autonomous column of decision-policy.md:

1. Fetch the items of the round: `node "${CLAUDE_PLUGIN_ROOT}/scripts/fix-review.mjs" fetch <pr url> --run-dir <run-dir>`, with `--reviewers <names>` when given. Take the failing checks from `failing_checks` of the `fix` action.
2. Classify each item and each failing check per decision-policy.md (A-Fix, B-Decide, B-Scope, Reject), and show them grouped by class, one line each with its reviewer and location.
3. Ask for each B-Decide item (its options, the recommended one first) and each B-Scope item (defer, fix now, reject; defer recommended). A-Fix and Reject items follow the recommendation unless the user says otherwise. With no B items, show the groups and continue.
4. Log each answer with `runs.mjs decision --run-dir <run-dir>` (`phase: fix-review`, `source: operator`, the item in `refs`), then pass the answers to the fixer in `<extra context>`: per item, its ID or URL, the class and the chosen action.

## Merge

1. With `pr.body_from_run`, refresh the body: `ship.mjs pr-body --out <run-dir>/pr-body.md`, then `gh pr edit <url> --body-file <run-dir>/pr-body.md`.
2. In `all` mode, run the before-merge checkpoint (see Interactive Checkpoints in SKILL.md).
3. `phase merge --status started`, then spawn the `fixer` phase subagent on `skills/github/esp-merge/SKILL.md` with `--pr <pr url>`.
4. `phase merge --status done` when it ended `merged` or `done`. A merge blocked by a condition ends the task with `awaiting-human` and the pull request left open.
