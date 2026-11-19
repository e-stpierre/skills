# Internal Review

The `review` phase of the orchestrated track: bounded review and fix rounds on the task branch, before anything is pushed. `ship.internal_review_rounds` (`2`) caps the rounds, and `0` skips the phase in every review mode.

`--review` (config `ship.review_mode`, default `auto`, see the `-R` argument) picks the review phases at `ship.mjs init`. A dropped phase is `skipped` in `ship.json`, with its reason in `skipped_phases` (`--review pr` for a flag, `ship.review_mode pr` for the config). With `auto`, the review gate decides the internal review after the build.

## Review Gate

With `auto`, `ship.mjs next` returns `action: review-gate` once the build and the final gates are done. Run `ship.mjs review-gate`, then `next` again. The gate reads the real diff (`base_sha..HEAD` in the task tree), the milestone complexities of the plan and the run's `max_risk`, and skips the internal review only when every rule holds:

- the diff has at most `ship.auto.review_max_files` (`3`) files and `ship.auto.review_max_lines` (`150`) added plus deleted lines
- every milestone is `low`
- `max_risk` is `low` (an unknown risk counts as not low)
- no changed path matches `ship.review.always_paths` (auth, security, migrations and CI config by default)

It logs one `policy` decision (`Skip the internal review` or `Run the internal review`) with the numbers in `x-esp-review-gate`, and records `review_gate` in `ship.json`. A skip marks the `review` phase `skipped` with the reason `review gate: ...`. A later call prints the recorded gate and logs nothing.

## Review Loop

`ship.mjs next` returns `phase: review` with `sub` and `loop` (`loop.step` is the step of this round, `loop.findings_path` the findings to fix):

- **`sub: review`** (`reviewer` role): spawn the phase subagent on `skills/review/esp-review/SKILL.md` with `--plan <plan_path> --target origin/<base>`, on the task branch. Its step is `loop.step` (`review-<N>`)
- **`sub: review-fix`** (`fixer` role): spawn the phase subagent on `skills/github/esp-fix-review/SKILL.md` with `--internal --findings <loop.findings_path>`. It makes a review-fix commit titled per `commit.style` (`plain`: `Fix review findings: <summary>`, `conventional`: `fix(review): <summary>`) and never pushes

`ship.mjs review-loop` prints the loop state at any time. The loop ends when `next` returns `complete`, `halt` or `stop` (see Task State in SKILL.md).

In `all` mode, run the before-fix checkpoint (see Interactive Checkpoints in SKILL.md) before each fix, and pass the answers to the fixer.
