---
name: normalize
description: Validate prompt files and plugin READMEs against the repository templates. Use before opening a PR that changes a skill, an agent or a plugin README, or when asked to normalize prompt files.
argument-hint: "[-a|--autofix] [-t|--target <path>...]"
---

# Normalize

## Overview

Validate agents, skills and plugin READMEs against their templates, and check that every skill ships in its plugin manifest. Use it before a pull request that touches a prompt file. The templates and the esp-create-skill checklist hold the rules; this skill applies them and reports every deviation.

## Arguments

### Definitions

- **`[-a|--autofix]`** (optional): Read from `-a` or `--autofix`. Fix the mechanical issues in place (see Autofix). Without it, only report.
- **`[-t|--target <path>...]`** (optional): Read from `-t` or `--target`. A file or a directory to validate. Repeat the option or pass a comma-separated list. Defaults to every prompt file in the repository.

### Values

Arguments: $ARGUMENTS

## Additional Resources

- For the skill rules, see the Validate step of [esp-create-skill](../../../plugins/esp-skills/skills/authoring/esp-create-skill/SKILL.md) and its [action-skill-template.md](../../../plugins/esp-skills/skills/authoring/esp-create-skill/references/action-skill-template.md): read both before validating a skill
- For agents, see [agent-template.md](../../../docs/templates/agent-template.md): read it before validating an agent
- For plugin READMEs, see [readme-template.md](../../../docs/templates/readme-template.md): read it before validating a README

## Core Principles

- The templates and the esp-create-skill Validate step are the only source of rules: read them on every run, and report a rule they do not state as a suggestion, not a failure
- Report every issue with its file, line and the rule it breaks, so a fix needs no second lookup
- Write files only with `--autofix`, and only for mechanical fixes; content a person must write is reported, never stubbed
- `plugin.json` is never edited: whether a skill ships is the author's decision

## Skill-Specific Guidelines

### File Classes

- **Skill**: a `SKILL.md` under a `skills/` path segment (`plugins/*/skills/**`, `.claude/skills/**`). Other files in a skill's `references/`, `scripts/` or `assets/` are support files: check only that SKILL.md links them and that the links resolve
- **Agent**: a `.md` file directly under a plugin's `agents/` directory
- **README**: `plugins/<plugin>/README.md`. READMEs in subdirectories are skipped
- **Workflow**: a `.yaml` file under `af-workflows/`: every `skill:` value uses the full plugin namespace (`esp-skills:esp-plan`)
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

1. **Parse arguments**: `-a|--autofix`, and every `-t|--target` value. Done when the target list is known (the repository root when none is given).
2. **Discover files**: glob `plugins/**/*.md`, `plugins/**/af-workflows/*.yaml` and `.claude/skills/**/SKILL.md` under each target, and classify each file (see File Classes). Done when every file is classified; with no target and zero prompt files found, warn that discovery failed.
3. **Read the rules**: the template of each class present, and for skills the esp-create-skill Validate step. Done when each check you will run comes from one of them.
4. **Validate each file**: frontmatter, section names and order, and the content checks of its rules. For a skill, run every bullet of the esp-create-skill Validate step. Done when every file has a pass or a list of issues.
5. **Check registration**: for each plugin with a `skills` array in `.claude-plugin/plugin.json`, every skill directory outside `skills/in-progress/` is listed as `./skills/<category>/<skill-name>`, every listed path has a `SKILL.md`, and no path is listed twice. In-progress skills are reported as not shipped. Done when each plugin has a registration result.
6. **Autofix** (with `-a|--autofix`): apply the fixes of Autofix, then validate the changed files again. Done when every remaining issue needs an author.
7. **Report** per Output Guidance.

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

Checked 22 files (15 skills, 3 agents, 1 README, 3 workflows): 20 pass, 2 with issues, 1 fixed.
```

When every file passes, print only the summary line.
