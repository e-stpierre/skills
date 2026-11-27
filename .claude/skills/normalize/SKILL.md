---
name: normalize
description: Validate prompt files and plugin READMEs against the repository templates. Use before opening a PR that changes a skill, an agent or a plugin README, or when asked to normalize prompt files.
argument-hint: "[-a|--autofix] [-t|--target <path>...]"
---

# Normalize

## Overview

Validate agents, skills and plugin READMEs against their templates. `scripts/validate-prompts.mjs` runs the mechanical checks (the same ones `pnpm check` runs in CI); this skill runs it, then adds the judgment checks a script cannot make, and fixes what it can. Use it before a pull request that touches a prompt file.

## Arguments

### Definitions

- **`[-a|--autofix]`** (optional): Read from `-a` or `--autofix`. Fix the mechanical issues in place (see Autofix). Without it, only report.
- **`[-t|--target <path>...]`** (optional): Read from `-t` or `--target`. A file or a directory to validate. Repeat the option or pass a comma-separated list. Defaults to every prompt file in the repository.

### Values

Arguments: $ARGUMENTS

## Additional Resources

- For the mechanical checks, see [validate-prompts.mjs](../../../scripts/validate-prompts.mjs): read it when a reported rule is unclear
- For the skill rules, see the Validate step of [esp-create-skill](../../../plugins/esp-skills/skills/authoring/esp-create-skill/SKILL.md) and its [action-skill-template.md](../../../plugins/esp-skills/skills/authoring/esp-create-skill/references/action-skill-template.md): read both before validating a skill
- For agents, see [agent-template.md](../../../docs/templates/agent-template.md): read it before validating an agent
- For plugin READMEs, see [readme-template.md](../../../docs/templates/readme-template.md): read it before validating a README

## Core Principles

- The templates and the esp-create-skill Validate step are the only source of rules: report a rule they do not state as a suggestion, not a failure
- The script owns the mechanical checks: report its issues as it prints them, and spend the review on what it cannot check
- Report every issue with its file, line and the rule it breaks, so a fix needs no second lookup
- Write files only with `--autofix`, and only for mechanical fixes; content a person must write is reported, never stubbed
- `plugin.json` is never edited: whether a skill ships is the author's decision

## Skill-Specific Guidelines

### File Classes

- **Skill**: a `SKILL.md` under a `skills/` path segment (`plugins/*/skills/**`, `.claude/skills/**`). Other files in a skill's `references/`, `scripts/` or `assets/` are support files: check only that SKILL.md links them and that the links resolve
- **Agent**: a `.md` file directly under a plugin's `agents/` directory
- **README**: `plugins/<plugin>/README.md`. READMEs in subdirectories are skipped
- **Skipped**: `CHANGELOG.md`, files under `local/`, `docs/templates/` and `node_modules/`, and anything else unclassified (listed in the report)

Match path segments, not substrings: the plugin directory `esp-skills/` is not a `skills/` segment.

### Autofix

Mechanical fixes only:

- Rename a heading whose case or spelling differs from the template, and drop a leftover `(optional)` marker
- Reorder sections to the template order, moving each section with its content
- Set a skill's frontmatter `name` to its directory name (never rename the directory), and quote an unquoted `argument-hint`
- Replace a non-ASCII character in a code file or a markdown file with its ASCII equivalent, keeping functional emojis in markdown

Everything else (a missing section, a weak description, a step without a done-condition, a missing link condition) is reported for the author.

## Instructions

1. **Parse arguments**: read `-a` or `--autofix`, and every `-t` or `--target` value. Done when the target list is known (the repository root when none is given).
2. **Run the script**: `node scripts/validate-prompts.mjs --json`, and keep the issues whose file is under a target. It covers frontmatter, sections, arguments and option letters, link conditions, leftovers, links, ASCII, size, registration and marketplace order, and, in plugin skills, agents, skill and shared references and the README, Claude variables outside an `In Claude Code,` line (`claude-variable`), relative paths that do not resolve (`path`) and a skill with relative paths that does not state their base (`paths-note`). Done when the script has exited 0 or 1 (2 is a usage error: report it and stop).
3. **Classify the targeted files** (see File Classes), and read the template of each class present and, for skills, the esp-create-skill Validate step.
4. **Judgment checks** on each targeted file: the description follows the invocation rule (a user-invoked one-line summary, or a model-invoked front-load with one trigger per case), the body reads each option by both names, every step ends on a checkable done-condition, and target behaviors are stated positively. Done when every file has a pass or a list of issues.
5. **Autofix** (with `-a|--autofix`): apply the fixes of Autofix, then run the script again. Done when every remaining issue needs an author.
6. **Report** per Output Guidance, script issues first.

## Output Guidance

List only the files with issues, grouped by file, then a one-line summary. Use `[FAIL]` for a broken rule, `[WARN]` for a suggestion, `[FIXED]` for an autofix, `[INFO]` for a skipped or unshipped file:

```markdown
## Normalize

### plugins/esp-skills/skills/sdlc/esp-ship/SKILL.md (Skill)

- [FAIL] line 46: Additional Resources link has no when-to-read condition
- [FIXED] line 57: renamed "## Templates (optional)" to "## Templates"

### plugins/esp-skills/.claude-plugin/plugin.json (Registration)

- [FAIL] skill not listed: `./skills/sdlc/esp-new`
- [INFO] not shipped (in progress): `skills/in-progress/esp-draft`

Checked 19 files (15 skills, 3 agents, 1 README): 17 pass, 2 with issues, 1 fixed.
```

When every file passes, print only the summary line.
