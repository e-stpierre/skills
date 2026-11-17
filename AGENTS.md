# Agent Instructions

## Project Overview

The `skills` repository is a collection of modular extensions for AI coding agents: reusable agents, skills, scripts and workflows. Everything ships as a single plugin, `esp-skills` (`plugins/esp-skills/`), published through the `esp` marketplace (`.claude-plugin/marketplace.json`).

## Repository Structure

- `docs/templates/`: the agent and plugin README templates
- `scripts/validate-prompts.mjs`: the repository check of prompt files against the templates (`pnpm validate`), with its tests in `scripts/tests/`
- `plugins/<plugin-name>/`: one self-contained plugin
  - `.claude-plugin/plugin.json`: the plugin manifest. Its `skills` array lists every skill that ships
  - `agents/`: subagent prompts, each focused on one task
  - `skills/<category>/<skill-name>/`: one skill per directory (e.g., `skills/git/esp-branch/`), with `SKILL.md` (required) and optional `references/`, `scripts/` and `assets/`. A skill missing from the `skills` array (e.g., work in progress under `skills/in-progress/`) stays in the repository but is not installed
  - `workflows/`: saved Workflow scripts (`<name>.js`), discovered by Claude Code with no manifest entry and listed as `esp-skills:<name>`. Test-only workflows live under `scripts/tests/fixtures/workflows/` so they never ship
  - `references/`: reference shared by several skills (decision policy, plan format, config schema, run directory)
  - `scripts/`: Node 22 ESM scripts shared by the skills, with no runtime dependencies, and their `node:test` tests in `scripts/tests/`
  - `CHANGELOG.md`: the plugin version history, brief, focused on what changed
  - `README.md`: plugin-specific documentation only. It opens with an `Overview` section that lets a user understand and use the plugin in two minutes, and ends with a complete example section covering every skill and argument

## Plugin Development Guidelines

### Language Style

Use US English spelling in all code, comments, documentation, and UI strings (e.g., "analyze", "color", "canceled").

### Naming Conventions

- **Agents**: kebab-case file names prefixed with `esp-` (e.g., `esp-builder.md`)
- **Skills**: kebab-case directory names prefixed with `esp-` (e.g., `esp-branch/`, `esp-plan/`). The skill `name` in the frontmatter matches the directory name
- **Workflows**: kebab-case file names prefixed with `esp-` (e.g., `esp-ralph-loop.js`). The `meta.name` matches the file name, and differs from every skill name: a saved workflow is listed as a skill under its own name

### Workflow Scripts

- `meta` comes first and is a pure literal (no variables, calls, spreads or template interpolation) with `name` and `description`; every `phase()` title appears in `meta.phases`
- No `import`, `require`, `Date.now()`, `Math.random()` or argless `new Date()`: pass times and other inputs through `args`
- **Agent Type Namespacing**: a workflow names a plugin agent with the full namespace, `agentType: 'esp-skills:esp-iterator'`, never the bare agent name. Built-in types (`general-purpose`, `Explore`, `Plan`) stay bare
- Test a workflow with the fake harness, `plugins/esp-skills/scripts/tests/helpers/fake-workflow.mjs`, which runs it with scripted agent replies and records every call

`pnpm validate` checks these rules for every `plugins/<plugin>/workflows/*.js`.

### Documentation Guidelines

- **Plugin READMEs**: plugin-specific information only. Installation, marketplace setup, contributing, license and support live in the root README; link to it
- **ASCII only**: code files use only ASCII characters, to avoid encoding issues across platforms. Markdown files follow the same rule, with one exception: minimal, functional emojis that convey information the reader needs (e.g., status indicators, severity markers)
- **Workflow diagrams**: arrow notation (`Plan -> Implement -> Validate -> Output`) instead of ASCII box diagrams

### Prompt Template Convention

Every prompt file and plugin README follows the exact structure of its template:

- `docs/templates/agent-template.md`: agent prompts
- `plugins/esp-skills/skills/authoring/esp-create-skill/references/action-skill-template.md`: skill prompts
- `docs/templates/readme-template.md`: plugin README files

Required sections are present, optional ones may be omitted, and section names match the template exactly (case-sensitive). Templates mark each placeholder `{{variable_name}}` and put the instructions for a section in an HTML comment below it:

```markdown
## {{section_title}}

{{content}}

<!--
Instructions:
- Replace {{content}} with the actual content
- Suggested elements (include others as needed):
  - Element 1
-->
```

`pnpm validate` checks the mechanical rules (sections, frontmatter, arguments, links, registration) and runs in `pnpm check`. `/normalize [-t|--target <path>]` runs it and adds the judgment checks (`-a|--autofix` to fix the mechanical issues).

### Marketplace Ordering

Plugins in `.claude-plugin/marketplace.json` are listed in alphabetical order by `name`.

### Code Style and Formatting

CI validates format, lint, and tests on all pull requests. Run locally before opening a pull request:

```bash
pnpm check          # Format, lint and prompt validation
pnpm test           # Script tests
```
