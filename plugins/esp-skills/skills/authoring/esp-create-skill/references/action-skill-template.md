<!--
SKILL PROMPT TEMPLATE

This template defines the exact structure for skill prompts. One SKILL.md serves every supported
harness (Claude Code and Codex): follow PORTABILITY below.

FILE SIZE LIMIT:
- Keep SKILL.md under 500 lines. Move material only some branches need to references/, behind a
  pointer that says when to read it.

DIRECTORY STRUCTURE:
A skill is a directory containing at minimum a SKILL.md file. Optional directories:
- scripts/   - Executable code that agents can run (Python, Bash, JavaScript)
- references/ - Additional documentation (REFERENCE.md, domain-specific files)
- assets/    - Static resources (templates, images, data files, schemas)
- agents/openai.yaml - Codex metadata: UI names and the invocation policy (see PORTABILITY)

Link every supporting file from SKILL.md with the condition for reading it, one level deep.
Avoid deeply nested reference chains.

YAML FRONTMATTER:
Every skill requires YAML frontmatter between `---` markers, starting on line 1 of SKILL.md
with no blank line inside (the blank lines below come from this template being markdown).

Write strict YAML: a lenient parser accepts what a strict one rejects, and a harness that parses
strictly drops the whole skill. Quote a value that contains ": " or " #", or that starts with a
YAML indicator ([ { * & ! | > % @ or a backtick). `pnpm validate` checks this.

Agent Skills Standard Fields:
- name (required): max 64 chars. Lowercase letters, numbers, hyphens only. Must match parent directory name.
  Must not start/end with hyphen or contain consecutive hyphens (--).
- description (required): max 1024 chars. Describes what the skill does and when to use it.
  Model-invoked: front-load what it is, then one trigger per distinct case. User-invoked: a one-line summary.
  The skill listing truncates it at 250 chars.
- license (optional): license name or reference to a bundled license file (e.g., `Apache-2.0`, `LICENSE.txt`).
- compatibility (optional): max 500 chars. Environment requirements (system packages, network access, etc.).
  Set it for hard requirements, e.g., "Requires git, gh and Node 22; parallel milestones need Claude Code".
- metadata (optional): arbitrary key-value mapping for additional properties (author, version, etc.).
- allowed-tools (optional): space-delimited list of pre-approved tools the skill may use.

Claude Code Specific Fields:
All optional:
- argument-hint: hint shown during autocomplete for expected arguments.
- disable-model-invocation: set `true` to prevent Claude from loading it, even when the user names it mid-prompt
  (only the user invokes it, as the first element of the prompt). Reserve it for skills that chain actions
  which are hard to undo or reach other people, with no confirmation the model would stop at (e.g., a full
  ship-to-merge pipeline). Every other skill stays model-invoked, including those with side effects (commit,
  branch, PR, merge, config change): their own confirmations, dry runs and objective checks guard the action.
  Default: false.
- user-invocable: set `false` to hide from / menu. Use for background knowledge that is not an actionable
  command. Default: true. Omit both fields for a skill the user types and Claude also reaches on its own.
- model: model to use when this skill is active.
- effort: effort level when active. Overrides session level. Options: low, medium, high, xhigh, max.
- context: set to `fork` to run in a forked subagent context (no conversation history).
- agent: which subagent type to use when `context: fork` is set.
- hooks: hooks scoped to this skill's lifecycle.
- paths: glob patterns limiting when skill activates. Comma-separated or YAML list.
- shell: shell for !`command` blocks. Options: bash (default), powershell.

ARGUMENT CONVENTIONS:
Skills take arguments like a standard CLI: every discrete value is a named option with a short
and a long name, and only free text is positional. The full rules (notation, order, reserved and
plugin-wide short letters) are in the Argument Conventions section of esp-create-skill SKILL.md.

STRING SUBSTITUTIONS:
Claude Code replaces these variables in skill content before sending to the model. Other harnesses
do not, so a skill never depends on them (see PORTABILITY):

- $ARGUMENTS: all arguments as a single string. Appended as `ARGUMENTS: <value>` if absent.
- $ARGUMENTS[N]: access a specific argument by 0-based index (e.g., $ARGUMENTS[0] for first).
- $N: shorthand for $ARGUMENTS[N] (e.g., $0 for first, $1 for second).
- ${CLAUDE_SESSION_ID}: current session ID. Useful for logging or session-specific files.
- ${CLAUDE_SKILL_DIR}: directory containing this SKILL.md. Use in !`command` to reference bundled
  scripts/files regardless of working directory.

DYNAMIC CONTEXT INJECTION (Claude Code only; give the skill a fallback step that runs the command):
- Use `!`command`` syntax to run shell commands before skill content is sent to Claude.
- The command output replaces the placeholder. Example: `!`git status`` inserts current git status.
- In Claude Code, ${CLAUDE_SKILL_DIR} names the skill's directory in such a command.

PORTABILITY:
The skill runs unchanged in Claude Code and Codex. Write for any harness with a shell, Node 22,
git and gh, and treat Claude Code features as optional enhancements with a stated fallback.
- Actions, not tools: "read the file", "run the command", "search the code". Name a harness tool
  only in a sentence that says it applies to that harness ("In Claude Code, ...").
- Paths: a relative path resolves against the directory of the file that holds it: the skill's
  directory for SKILL.md (../../../scripts/config.mjs reaches the shared scripts), one level
  deeper for a file in references/. Commands keep the literal relative path, and the model
  resolves it to an absolute path before running the command: commands run from the user's
  repository. State it once, in Core Principles, with this exact sentence: "Paths are relative to
  this skill's directory (a reference file's paths are relative to that file). Resolve a path to
  an absolute one before running a command with it: commands run from the user's repository".
- Claude variables: ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_SKILL_DIR} appear only on a line that
  starts with "In Claude Code," (after a list, blockquote or bold marker): other harnesses leave
  them unexpanded, so such a line is an enhancement, never the only way to a file.
- Arguments: keep the Values subsection as the template shows, including its fallback line, so a
  harness that does not substitute the placeholder still gets the arguments from the message.
- Other skills: name them bare ("invoke the esp-ship skill"), never as a slash command or with the
  plugin namespace. The per-harness syntax (/esp-skills:esp-ship, $esp-ship) belongs in the README.
- Questions: "ask the user, with the session's question tool if it has one, otherwise in plain
  text, one question at a time with the recommended answer first".
- Subagents: "delegate to a subagent with a fresh context window, briefed with agents/<role>.md;
  in Claude Code, use the esp-skills:<role> agent type; without subagents, follow agents/<role>.md
  in this session". State "fresh context": some harnesses fork the conversation by default.
- Background and parallel work: "when the harness supports it; otherwise one after another". The
  result must be the same either way.
- Models: name a tier from the configuration (models.<role>), never a model name or alias.
- Headless: "a non-interactive session", never one harness's command.
- Claude Code-only features (workflows, context: fork, hooks, dynamic context injection): give a
  fallback, or a compatibility line and a clear message when the harness lacks them.
- Codex invocation policy: a skill with disable-model-invocation: true also has
  agents/openai.yaml with policy.allow_implicit_invocation: false. A model-invoked skill never sets
  it to false (Codex would hide the skill). The file is optional otherwise:
    interface:
      display_name: "ESP Ship"
      short_description: "Ship a task to a merged pull request"
    policy:
      allow_implicit_invocation: false

REQUIRED SECTIONS (in order):
1. Overview - Skill purpose and objective (combines definition + goal)
2. Arguments - Only if skill takes arguments (must include Definitions and Values subsections)
3. Core Principles - Key guidelines, constraints, and important notes
4. Instructions - Step-by-step execution guide
5. Output Guidance - Expected output format (human-readable text)

OPTIONAL SECTIONS (insert in order shown):
- Additional Resources - After Arguments, for links to supporting files
- Skill-Specific Guidelines - After Core Principles, for domain-specific guidance
- Templates - After Output Guidance, for structured output templates

SECTION ORDER MUST BE RESPECTED - Follow the order defined above.
Drop the "(optional)" marker from the heading of each optional section you keep.

VALIDATION RULES:
- Arguments section and argument-hint frontmatter are REQUIRED only when the skill takes arguments
- Arguments section and argument-hint should be OMITTED when the skill takes no arguments
- Interactive skills output human-readable text (not JSON) for direct user consumption
-->
<!-- markdownlint-disable MD041 -->

---

name: {{skill-name}}
description: {{skill-description}}
argument-hint: "{{argument-pattern}}"

---

# {{skill_title}}

## Overview

{{overview}}

<!--
Instructions:
- Replace {{overview}} with 2-4 sentences describing:
  - What the skill does
  - When to use it
  - The primary goal it achieves
- This section combines the skill definition and objective
-->

## Arguments

### Definitions

{{argument_definitions}}

<!--
Instructions:
- Replace {{argument_definitions}} with a bullet-point list defining each argument
- Format: **`-t|--type <type>`** (required): Description, with the valid values
- Format: **`[-b|--base <branch>]`** (optional): Description. Defaults to `value`.
- Format: **`[-D|--draft]`** (optional): What the flag turns on
- Format: **`[context]`** (optional): The free text, always last
- List them in argument-hint order
- Omit this section entirely if the skill takes no arguments
-->

### Values

Arguments: $ARGUMENTS

If the line above holds no arguments or an unreplaced placeholder, read them from the message that invoked this skill.

<!--
Instructions:
- MUST use the `Arguments: $ARGUMENTS` format (with the "Arguments:" prefix), followed by the fallback line as written
- Using `$ARGUMENTS` alone on a line breaks markdown syntax because the dollar sign
  is interpreted as a LaTeX/math delimiter by some renderers
- The $ARGUMENTS placeholder is automatically replaced with all arguments passed when invoking the skill
- If $ARGUMENTS is not present in the content, arguments are appended as `ARGUMENTS: <value>`
- The fallback line covers harnesses that do not substitute $ARGUMENTS
- Do not modify this subsection
-->

## Additional Resources (optional)

{{additional_resources}}

<!--
Instructions:
- Replace {{additional_resources}} with links to supporting files
- Format: - For <purpose>, see [filename.md](filename.md)
- State when to read each file (e.g., "read it before creating a new file"), so the pointer fires on the right branch
- Use for reference docs, examples, or scripts in the skill directory
- Write paths relative to the directory of the file that holds them (this skill's directory for SKILL.md), never with a Claude variable, and state the convention once in Core Principles (see PORTABILITY)
- Omit this section if skill has no supporting files
-->

## Core Principles

{{principles}}

<!--
Instructions:
- Replace {{principles}} with bullet points of key guidelines
- Include constraints, quality standards, and behavioral expectations
- Include security considerations where relevant
- Include critical warnings and important notes
- Keep only principles that change behavior versus the model's default, each stated once
- State the target behavior positively ("Do X" instead of "Don't do X")
- Reserve "Don't" for hard guardrails where violation would cause serious issues, and pair it with what to do instead
-->

## Skill-Specific Guidelines (optional)

{{skill_specific_guidelines}}

<!--
Instructions:
- Replace {{skill_specific_guidelines}} with domain-specific behavioral guidance
- Each guideline must be in a sub-section (###) with a clear, descriptive title
- Use for specialized context that doesn't fit standard sections
- Include examples, conventions, or patterns specific to this skill's domain
- Avoid tables: write `**Key**: effect` lists or one sentence per option. Keep a table only for a true grid (several attributes compared across many rows)
- Omit this section if not needed
-->

## Instructions

{{instructions}}

<!--
Instructions:
- Replace {{instructions}} with numbered step-by-step execution instructions
- Use format: 1. First action, 2. Second action, etc.
- Provide logical sequence from start to completion
- End each step on a checkable completion criterion (e.g., "Done when `git branch --show-current` prints the new name"); prefer an exhaustive one ("Done when every file in scope is checked") over a vague one ("Done when the code is understood")
- Include verification or validation steps
-->

## Output Guidance

{{output}}

<!--
Instructions:
- Replace {{output}} with expected output format and content definition
- Interactive skills output human-readable text for direct user consumption
- Skills may also produce additional outputs (e.g., create files, write markdown) during execution
- Define the expected text format and key information to include
- Use clear headings and formatting for readability
-->

## Templates (optional)

{{templates}}

<!--
Instructions:
- Replace {{templates}} with embedded templates for structured outputs
- Use code blocks to show template structure
- Include placeholders with clear naming (e.g., [Feature Name], {{variable}})
- Document each section of the template
- This section is recommended for skills that generate files or structured output
-->
