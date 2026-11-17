# Ralph Task: Fix the accepted findings of the security audit

**Repository**: /home/dev/repos/billing-api

## Source

`/home/dev/repos/billing-api/analysis/security-audit.md`: a findings document, one `### F<N>` section per finding, each with a severity, a location, and a `Decision:` line (`fix`, `defer` or `wontfix`) set by the user.

## Tracker

The `Status:` line of each finding: `open`, `in progress` or `fixed (<short SHA>)`. Add the line under `Decision:` when it is missing. The document is git-ignored: never commit it.

## Unit

One finding.

## Pick Rule

The first finding with `Decision: fix` and a status other than `fixed`, in severity order (critical, high, medium, low), then in document order. Skip every `defer` and `wontfix` finding, and never change a `Decision:` line.

## Required Reading

1. The findings document in full.
2. `/home/dev/repos/billing-api/AGENTS.md` and `/home/dev/repos/billing-api/CLAUDE.md`.
3. The files at the finding's location, and their tests.

## Procedure

1. Work on the branch `fix/security-audit`. When it does not exist, create it from an up-to-date `main` with `esp-branch`. Otherwise check it out and pull.
2. Fix the finding at its root cause, with a regression test when the code is testable.
3. When the fix changes behavior a caller relies on, describe it under `Notes:` in the finding.

## Verify

`pnpm vitest run <the changed test files>` and `pnpm typecheck`. Leave the full suite and lint to the finish step.

## Commit

One commit per finding with `esp-commit`, titled with the finding's subject, not its ID. Push the branch after each commit.

## Conventions

- Use `esp-branch`, `esp-commit` and `esp-pr` for every git operation
- Never edit `migrations/` or `.github/workflows/`: a finding that needs it is blocked
- Follow the repository's `AGENTS.md`

## Questions

The bar is high: append an operator question to the run notes only when a fix would change a public API, a stored data format or an authentication flow. Then keep the finding `open`, note the question, and move on to the next finding. Decide everything else alone and log it as a decision.

## Completion

Every finding with `Decision: fix` is `fixed`, or open with an operator question in the run notes, and the pull request is open.

## Finish

Run `pnpm test` and `pnpm lint`, fix what they report, then open the pull request with `esp-pr`. List the open questions in its description.
