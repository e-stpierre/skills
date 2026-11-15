<!--
AGENT PROMPT TEMPLATE

This template defines the exact structure for Claude Code agent prompts.

FRONTMATTER:
Starts on line 1 of the agent file, with no blank line inside (the blank lines below come from
this template being markdown). Field names are camelCase; Claude Code ignores unknown fields.

Required:
- name: kebab-case identifier, matching the file name (`esp-builder.md` -> `esp-builder`). No `:`
- description: one line saying what the agent does, so the caller knows when to delegate to it.
  Front-load the task; a caller reads it in the agent listing

Used by every agent in this repository (keep them):
- tools: allowlist, a YAML list (e.g., [Read, Write, Bash, Glob, Grep]). Grant the fewest tools the
  methodology needs; a read-only agent gets no Write, Edit or Bash
- model: `sonnet`, `opus`, `haiku`, `fable`, `inherit`, or a full model ID. Prefer an alias
- color: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink` or `cyan`

Optional:
- disallowedTools: denylist, applied before `tools`
- effort: `low`, `medium`, `high`, `xhigh` or `max` (levels depend on the model)
- maxTurns: maximum agentic turns
- skills: YAML list of skills to preload (not skills with `disable-model-invocation: true`)
- memory: `user`, `project` or `local`
- background: `true` to always run in the background
- isolation: `worktree` to run in a temporary git worktree

Plugin agents ignore `hooks`, `mcpServers`, `permissionMode` and `initialPrompt`: put hooks in
the plugin's `hooks/hooks.json` and MCP servers in its `.mcp.json`.

REQUIRED SECTIONS (in order):
- Purpose
- Methodology
- Tools Available
- Capabilities
- Knowledge Base
- Output Guidance
-->
<!-- markdownlint-disable MD041 -->

---

name: {{agent-name}}
description: {{agent-description}}
tools: [{{tool1}}, {{tool2}}, {{tool3}}]
model: {{model-choice}}
color: {{color-name}}

---

# {{agent_title}}

## Purpose

{{purpose}}

<!--
Instructions:
- Replace {{purpose}} with a concise statement of the agent's role
- Define the agent's domain expertise and primary function
- Explain what problems this agent solves
- Clarify when this agent should be invoked
-->

## Methodology

{{methodology}}

<!--
Instructions:
- Replace {{methodology}} with the approach and framework the agent follows
- Sub-sections (### headings) are allowed for complex methodologies (e.g., "### Initial Assessment", "### Deep Analysis")
- Suggested elements (include others as needed):
  - Analysis techniques and decision-making processes
  - How the agent breaks down complex problems
  - Quality standards and verification methods
  - Step-by-step workflow approach
-->

## Tools Available

{{tools}}

<!--
Instructions:
- Replace {{tools}} with description of each tool and how the agent uses it
- Format: **Tool Name**: How the agent uses this tool in its workflow
- Include guidance on tool selection and sequencing
- Explain when to use each tool
- Suggested elements (include others as needed):
  - Tool-specific usage patterns
  - Tool combinations and workflows
  - Tool limitations within agent's domain
-->

## Capabilities

{{capabilities}}

<!--
Instructions:
- Replace {{capabilities}} with specific tasks and operations the agent can perform
- List concrete capabilities as bullet points
- Define scope boundaries (what the agent can and cannot do)
- Note any limitations or prerequisites
- Suggested elements (include others as needed):
  - Primary capabilities (core functions)
  - Secondary capabilities (supporting functions)
  - Edge cases or limitations
  - Integration points with other systems
-->

## Knowledge Base

{{knowledge}}

<!--
Instructions:
- Replace {{knowledge}} with domain knowledge and expertise the agent possesses
- Suggested elements (include others as needed):
  - Technical domains and frameworks
  - Best practices and standards it follows
  - Reference materials it draws upon
  - Specialized terminology or concepts
  - Industry standards or conventions
-->

## Output Guidance

{{output}}

<!--
Instructions:
- Replace {{output}} with expected outputs and deliverables
- Suggested elements (include others as needed):
  - Output formats and structure
  - Required content and detail level
  - How results should be presented to the user
  - Error reporting and edge case handling
  - Follow-up actions or recommendations
-->
