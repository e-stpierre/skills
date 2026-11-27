---
name: esp-config
description: Manage the esp-skills configuration files. Use when asked to view, change, or validate esp-skills settings.
argument-hint: "<action> [-P|--project] [-f|--force] [-k|--key <key>] [-F|--file <path>] [-d|--run-dir <path>] [value]"
---

# ESP Config

## Overview

Manage the esp-skills configuration through the plugin's `config.mjs` script: create a starter config file, inspect the merged configuration, read or change one key, and validate config files. Configuration is optional: every skill falls back to the built-in defaults when no file exists.

## Arguments

### Definitions

- **`<action>`** (required): The leading word, one of:
  - `init` - Create a starter config file
  - `show` - Print the full merged config
  - `get` - Print one section or dotted key (e.g., `pr`, `pr.draft`, `defaults.models.reviewer`)
  - `set` - Set a key to a value in the user or project file
  - `unset` - Remove a key from the user or project file
  - `validate` - Validate every layer and the merged result, or one file with `--file`
  - `sources` - List the config layers and which ones are in use
- **`[-P|--project]`** (optional): Read from `-P` or `--project`. Target the project file (`<repo>/.esp-skills/config.json`) instead of the user file (`~/.esp-skills/config.json`) for `init`, `set`, and `unset`.
- **`[-f|--force]`** (optional): Read from `-f` or `--force`. Overwrite an existing file on `init`.
- **`[-k|--key <key>]`** (optional): Read from `-k` or `--key`. Section or dotted key; required for `get`, `set` and `unset`.
- **`[-F|--file <path>]`** (optional): Read from `-F` or `--file`. For `validate`, the config file to validate instead of every layer. Ignored by the other actions.
- **`[-d|--run-dir <path>]`** (optional): Read from `-d` or `--run-dir`. For `show`, `get`, `sources` and `validate`, resolve the config of that run: its frozen snapshot (see Layers) in place of the user and project layers, or the normal layers when the run has none. Never changes what `init`, `set` and `unset` write.
- **`[value]`** (optional): The trailing free text, the value for `set`. Parsed as JSON when valid (`true`, `3`, `null`, `["a"]`), otherwise used as a plain string.

### Values

Arguments: $ARGUMENTS

## Core Principles

- Every read and write goes through `config.mjs`, which validates each write before saving it
- Config files hold no secrets (tokens, passwords, API keys)
- A failed `set` leaves the file unchanged; report the script's error verbatim, it names the key path and the expected type
- Paths are relative to this skill's directory (a reference file's paths are relative to that file). Resolve a path to an absolute one before running a command with it: commands run from the user's repository. A bare script name (`config.mjs`) or `scripts/<name>` is the plugin's script, `../../../scripts/<name>` from this directory

## Skill-Specific Guidelines

### Layers

The script merges these layers, lowest to highest precedence:

1. Built-in defaults: `../../../references/config-defaults.json`
2. User config: `~/.esp-skills/config.json` (the `ESP_SKILLS_HOME` environment variable overrides `~/.esp-skills`)
3. Project config: `<repo>/.esp-skills/config.json`, where `<repo>` is the nearest git root
4. Frozen snapshot (esp-ship runs): esp-ship freezes the merged config in its run directory on the first call (`config.snapshot.json`, recorded in `ship.json`), so a resumed run keeps the config it started with. `config.mjs --run-dir <path>` reads it: the snapshot replaces the user and project layers, and defaults still fill missing keys. The phase skills esp-ship runs (esp-plan, esp-review, esp-fix-review, esp-pr, esp-merge) pass their `--run-dir` to `config.mjs get`, and the run's scripts (`merge-ready.mjs`, `fix-review.mjs`, `wait-for-review.mjs`, `gates.mjs`) read it from their own `--run-dir`, so the whole run uses the frozen config. A `set` during a run changes only later runs

Skill arguments override the resolved values in the skill that receives them. Objects merge key by key; arrays and scalar values replace the lower layer.

### Schema

Files are validated against `../../../references/config.schema.json`. Add `"$schema": "https://raw.githubusercontent.com/e-stpierre/skills/main/plugins/esp-skills/references/config.schema.json"` to a config file for editor completion; `init` adds it. Keys marked "Reserved" in the schema belong to skills that are not shipped yet.

## Instructions

1. Parse the arguments into the action, the flags, the key, the file, the run directory and the value. If the action is missing or unknown, list the valid actions and stop. If `get`, `set` or `unset` has no `-k|--key`, or `set` has no value, report the missing argument and stop. `--file` on another action than `validate` is ignored. Done when the action and every value it needs are known.
2. Build the command; the script takes the key and the value as positionals:

   ```bash
   node "../../../scripts/config.mjs" <action> [key] [value] [--project] [--force] [--file <path>] [--run-dir <path>]
   ```

   - Pass `-P|--project` as `--project`, `-f|--force` as `--force`, `-F|--file` as `--file` and `-d|--run-dir` as `--run-dir`; the script takes long names only
   - Quote the value so the shell passes it as one argument (e.g., `'["squash","merge"]'`)
   - For `get` and `show`, also run `sources` with the same `--run-dir`, for the provenance line of the report

3. Run the command from the current working directory so the project layer resolves to the current repository.
4. Read the exit code:
   - `0`: success, the output is JSON
   - `1`: invalid config or failed operation, the error names the file, key path and expected type
   - `2`: usage error (unknown action, unknown key, missing value)
5. Report the result per the Output Guidance, with the JSON the script printed for a read action.

## Output Guidance

Keep the output short.

**On `get` or `show`:** the script prints only the JSON value. Build the first line yourself from `sources`: the key (or `config` for `show`) and the layers marked `used`, in order. It names the layers in use, not which layer set each key.

````text
pr (layers in use: defaults, user)

```json
{ "base": null, "draft": true, "attribution": true }
```
````

**On `init`, `set`, or `unset`** (one line naming the action, the key and the file):

```text
Created ~/.esp-skills/config.json
Set pr.draft = true in ~/.esp-skills/config.json
Unset pr.draft in ~/.esp-skills/config.json
```

**On `sources`:**

```text
defaults: <plugin>/references/config-defaults.json (in use)
user: ~/.esp-skills/config.json (in use)
project: <repo>/.esp-skills/config.json (not used)
```

**On `validate`:**

```text
Config is valid: defaults, ~/.esp-skills/config.json
```

**On error:**

```text
Invalid config in ~/.esp-skills/config.json:
  pr.draft: expected boolean, got string "yes"
```
