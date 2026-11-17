# Cost and Tokens

A long esp-skills run (an `esp-ship` build, an `esp-ralph` loop, a Codex delegation) costs the tokens of the agents that do the work plus the tokens of the session that drives them. This page explains where those tokens go and the patterns the skills follow to keep them low.

## Where Tokens Go

- **Session start**: every Claude Code session or subagent starts at about 30k tokens of context (system prompt, tools, skill and agent definitions, `CLAUDE.md`) before it reads a single file
- **Turns**: every tool call ends a turn, and every turn re-sends the whole context. A turn of a coordinating session costs at least its context size, measured at 31k to 34k tokens for a fresh session
- **Cache reads**: most of that re-sent context is read from the prompt cache, at a tenth of the input price. In a measured multi-step run, 82% of the worker tokens were cache reads. A turn after the cache expires writes the whole context again
- **Tool results**: everything a tool returns stays in the context and is re-sent on every later turn. A large result early in a session is paid for on every turn after it

## Patterns

### Fresh Agents per Step

Each milestone of `esp-ship` runs in a fresh `esp-builder` and a fresh `esp-verifier`, and each `esp-ralph-loop` iteration in a fresh `esp-iterator`. A fresh agent pays the session start once, reads only what its step needs, and keeps its file reads out of the coordinating session. The alternative, one long session doing every step, re-sends every earlier step's reads on every later turn, and its cost grows with the square of its length.

The coordinator stays small for the same reason: subagents reply in a few markdown lines (see Replies in `references/decision-policy.md`), workflow agents return a schema-validated value, and the details stay in the run directory.

Builder reuse is the one exception, and it is bounded: `esp-ship` continues a builder with the next milestone only when the two are related and the estimated context stays under `ship.reuse.limit_tokens`.

### Block Instead of Polling

Waiting is where a coordinator wastes the most tokens, because every poll is a full turn. Measured on the same run, a coordinator that polled every 30 seconds with no filter used 2.8 times the tokens of one that blocked until something happened (52% of the worker tokens against 19%).

- **Waits are scripts**: `wait-for-review.mjs` polls GitHub with no model involved and runs in the background under Monitor, which wakes the session once per event
- **One Bash call per wait**: `codex.mjs wait` blocks for up to 9 minutes in a single foreground call, so a 30-minute Codex run costs at most four turns. Never wait with `sleep` loops
- **Workflows**: the `esp-ralph-loop` script decides what runs next with no model turn between iterations, and the launching session wakes once, when the workflow ends

A coordinator's cost per wake-up is fixed, so its share of the total falls as the steps grow. What grows with the run's length is the number of wake-ups: keep it to one per event that needs a decision.

### Cheap Models for Mechanical Roles

The model of each agent decides most of a run's cost. Keep the large model for planning, review and hard milestones, and use a small one where the work is mechanical:

- The `esp-codex` relay agent runs on Haiku: it writes a prompt file, runs `codex.mjs` and returns the result, and Codex itself does the work (on the Codex plan)
- Milestone `complexity` selects the builder model from `defaults.models`, so low-complexity milestones can run on a smaller model (see `references/model-selection.md`)
- `esp-ralph --model` and `--effort` set the model and effort of every loop iteration

### Small Tool Results

- Scripts print compact JSON to the model, and write long content (diffs, reviews, Codex answers) to files the agent reads only when it needs them
- Read a summary or one section of a file instead of the whole file, and filter long command output before it reaches the context

## Measuring and Bounding

- `/usage` breaks plan usage down by skill, subagent, plugin and workflow. Check the coordinating session's share after a long run: if it is large, the run waited or polled in the coordinator
- A workflow `budget` (for example `+500k` in the prompt) is a hard token ceiling: `agent()` throws past it
- `--max-budget-usd` bounds a headless session
- `ship.budgets.*` bound an `esp-ship` run by wall time and milestone count, and `esp-ralph --max-iterations` bounds a loop
