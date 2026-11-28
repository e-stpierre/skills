# Model Selection

Paths here are relative to this file's directory, the plugin's `references/`: resolve them to absolute paths before running a command.

How a skill picks the model and effort of every subagent it spawns. This is the only place the precedence is defined, and the only place that names harness models and effort values: agents and skills name a tier or a role and link here instead of repeating it.

## Tiers

A tier names a model class independently of the harness. The tiers are `low`, `medium` and `high`, the plan milestone complexities, and `--model <tier>` resolves one through `defaults.models.builder.<tier>` of the config. This table is the only per-harness model and effort table:

| Tier or role          | Claude Code (alias, effort) | Codex (model, reasoning effort) |
| --------------------- | --------------------------- | ------------------------------- |
| `low`                 | `sonnet`                    | `gpt-5.5-codex`, `low`          |
| `medium`              | `opus`                      | `gpt-5.5-codex`, `medium`       |
| `high`                | `opus`, `high`              | `gpt-5.5-codex`, `high`         |
| `mechanical`, `relay` | `haiku`                     | `gpt-5.5-codex`, `minimal`      |

The Claude Code column is the shipped config (`config-defaults.json`). In another harness, a config value that is a Claude Code alias maps to that harness's column through the row of the alias and effort (`fable` and an effort the column lacks, such as `max`, take the `high` row), and a harness model name in the config is passed as is.

## Roles

Each spawn site names a role. The role selects a key under `defaults.models` in the config (`node "../scripts/config.mjs" get defaults.models`).

| Role         | Spawned by                                                | Agent                    | Default tier             |
| ------------ | --------------------------------------------------------- | ------------------------ | ------------------------ |
| `planner`    | `esp-plan`, `esp-ship`                                    | none (plan phase)        | `high`                   |
| `explorer`   | `esp-plan`                                                | a read-only explorer     | `low`                    |
| `builder`    | `esp-ship` (milestone loop)                               | `agents/esp-builder.md`  | per milestone complexity |
| `verifier`   | `esp-ship` (milestone loop)                               | `agents/esp-verifier.md` | `low`                    |
| `reviewer`   | `esp-review`, `esp-ship`                                  | `agents/esp-reviewer.md` | `high`                   |
| `fixer`      | `esp-fix-review`, `esp-ship`                              | `agents/esp-builder.md`  | `medium`                 |
| `mechanical` | any skill, for rote work; `esp-ship` branch and PR phases | any                      | `mechanical` row         |
| `relay`      | workflows and skills that delegate to Codex               | `agents/esp-codex.md`    | `relay` row              |

`esp-ship` resolves these for you: `ship.mjs next` returns the model of each phase subagent, and `ship.mjs milestone models <id>` the builder and verifier models of a milestone. `builder` has one entry per plan milestone complexity: `low`, `medium` and `high`, each the tier of the same name.

In Claude Code, the agent of a role is the `esp-skills:<agent>` agent type (`esp-skills:esp-builder`), and the explorer is the built-in `Explore` type.

## Precedence

The first level that gives a value wins:

`--model flag` -> `plan milestone complexity` -> `config role` -> `agent frontmatter` -> `inherit`

1. **`--model` flag**: the user passed `--model <model>` to the orchestrator skill: a Claude Code alias (`opus`, `sonnet`, `haiku`, `fable`), a tier (`low`, `medium`, `high`, resolved through `defaults.models.builder.<tier>` with its effort) or a harness model name (letters, digits and `. - _ / :`, with at least one digit, such as `gpt-5.5-codex`). It applies to every spawn of the roles that skill documents.
2. **Plan milestone complexity**: for the `builder` role only, the milestone's `complexity` (`low`, `medium`, `high`) selects `defaults.models.builder.<complexity>`. A milestone without `complexity` uses `medium`. Plans never name models.
3. **Config role**: `defaults.models.<role>` from the merged config (defaults, user, project; esp-ship reads its frozen copy in `ship.json`). A value is a Claude Code alias or a harness model name.
4. **Agent frontmatter**: the `model` in the agent file. It is a static fallback, used only when the config has no entry for the role.
5. **Inherit**: no model parameter at all; the subagent uses the session model.

Effort follows the same order, but only a level that sets `effort` counts: `--effort` flag (where a skill offers it), then the config entry the model came from. When no level sets it, pass no effort and let the runtime default apply.

The precedence picks the builder model of every milestone, also when the esp-ship milestone loop continues an earlier builder: Builder Reuse in the esp-ship milestones reference continues one only when the resolved model and effort match.

## Rules

- Pass the resolved model and effort on each subagent spawn, when the harness lets a spawn set them. Do not rely on the frontmatter. A harness that cannot set them runs the subagent on its own default.
- In Claude Code, the Agent tool takes `model` and `effort` parameters and accepts aliases only (`opus`, `sonnet`, `haiku`, `fable`); agent frontmatter also accepts `inherit`. Never pass a full model ID: a harness model name of another harness (`gpt-5.5-codex`) has no alias, so the spawn passes no model and the subagent inherits the session model. When that happens, log a low-risk `policy` decision (`Ran <role> on the session model: <model> is not a Claude Code alias`) and record `<role>=inherit` (see the last rule). An effort Claude Code lacks (`minimal`) is passed as `low`.
- Worker skills invoked directly by a user (not spawned) run on the session model. A skill cannot switch the main session model.
- A headless session is a non-interactive session (for example `claude -p`, `codex exec`), detected from the harness. It sets its own model with the harness's own option. The precedence above still applies to the subagents it spawns.
- Record what was used: `runs.mjs update --run-dir <path> --model <role>=<model>[:<effort>]` keeps `run.json` `models` accurate for `esp-recap`.

## Example

A plan milestone `M2` declares `complexity: high`, no `--model` flag was given, and the user config sets `defaults.models.builder.high` to `{ "model": "opus", "effort": "max" }`:

- Builder for M2: `model: opus`, `effort: max` (level 2 selects the `high` entry, level 3 supplies it)
- Verifier for M2: `model: sonnet`, no effort (level 3, defaults)
