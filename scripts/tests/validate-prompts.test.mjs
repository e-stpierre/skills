import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TEMPLATES,
  hintTokens,
  parseToken,
  parseYaml,
  readImplicitPolicy,
  scanLines,
  validate
} from "../validate-prompts.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "scripts", "validate-prompts.mjs");

const SKILL = `---
name: esp-demo
description: Demo skill. Use to test the validator.
argument-hint: "[-n|--dry-run] [-t|--type <type>] [-r|--reviewers <name>...] [context]"
---

# Demo

## Overview

Demo.

## Arguments

### Definitions

- **\`[-n|--dry-run]\`** (optional): Read from \`-n\` or \`--dry-run\`.
- **\`[-t|--type <type>]\`** (optional): Read from \`-t\` or \`--type\`.
- **\`[-r|--reviewers <name>...]\`** (optional): Read from \`-r\` or \`--reviewers\`.
- **\`[context]\`** (optional): Free text.

### Values

Arguments: $ARGUMENTS

## Additional Resources

- For the details, see [notes.md](references/notes.md): read it before step 1

## Core Principles

- Be clear

## Skill-Specific Guidelines

### Rules

- One rule

## Instructions

1. Do it. Done when it is done.

## Output Guidance

\`\`\`text
{{example}} inside a fence is fine
\`\`\`
`;

const AGENT = `---
name: esp-helper
description: Helps with one task
tools: [Read, Grep]
model: sonnet
color: blue
---

# Helper

## Purpose

x

## Methodology

x

## Tools Available

x

## Capabilities

x

## Knowledge Base

x

## Output Guidance

x
`;

const README = `# Demo

## Overview

x

## Agents

x

## Skills

x

## Complete Examples

x
`;

const WORKFLOW = `// A demo workflow.
export const meta = {
  name: "esp-flow",
  description: "Demo workflow. Run it to test the validator.",
  phases: [{ title: "Work", detail: "one agent" }],
  count: -1,
  on: true,
  extra: null
};

const SCHEMA = { type: "object", properties: {}, required: [] };
phase("Work");
const note = "phase(\\"Elsewhere\\") and Date.now() in a string";
// Math.random() in a comment is fine
const out = await agent(\`Do it \${args?.n ?? 1}\`, {
  agentType: "esp-demo:esp-helper",
  schema: SCHEMA
});
const other = await agent("x", { agentType: "general-purpose" });
return { out, other, note, at: new Date(0) };
`;

const WORKFLOW_PATH = "plugins/esp-demo/workflows/esp-flow.js";

let root;

function write(rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function errors() {
  return validate(root).issues.filter((i) => i.level === "error");
}

function rules() {
  return errors().map((i) => i.rule);
}

const SKILL_PATH = "plugins/esp-demo/skills/demo/esp-demo/SKILL.md";

beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "validate-prompts-"));
  for (const path of Object.values(TEMPLATES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO, path), join(root, path));
  }
  write(SKILL_PATH, SKILL);
  write(
    "plugins/esp-demo/skills/demo/esp-demo/references/notes.md",
    "# Notes\n"
  );
  write("plugins/esp-demo/agents/esp-helper.md", AGENT);
  write("plugins/esp-demo/README.md", README);
  write(WORKFLOW_PATH, WORKFLOW);
  write(
    "plugins/esp-demo/.claude-plugin/plugin.json",
    JSON.stringify({ name: "esp-demo", skills: ["./skills/demo/esp-demo"] })
  );
  write(
    ".claude-plugin/marketplace.json",
    JSON.stringify({ plugins: [{ name: "a" }, { name: "b" }] })
  );
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("parsing", () => {
  test("hintTokens keeps a required option with its value", () => {
    assert.deepEqual(
      hintTokens(
        "<action> -s|--skill <name> [-r|--reviewers <name>...] [context]"
      ),
      [
        "<action>",
        "-s|--skill <name>",
        "[-r|--reviewers <name>...]",
        "[context]"
      ]
    );
  });

  test("parseToken reads options and positionals", () => {
    assert.deepEqual(parseToken("[-t|--type <type>]"), {
      kind: "option",
      token: "[-t|--type <type>]",
      short: "t",
      long: "type",
      value: "<type>"
    });
    assert.equal(parseToken("[context]").kind, "positional");
    assert.equal(parseToken("[--autofix]").kind, "invalid");
  });

  test("scanLines flags nested fences as code", () => {
    const lines = scanLines("a\n````text\n```json\n{}\n```\n````\nb");
    assert.deepEqual(
      lines.map((l) => l.code),
      [false, true, true, true, true, true, false]
    );
  });
});

describe("validate", () => {
  test("a conforming fixture has no error", () => {
    assert.deepEqual(errors(), []);
  });

  test("the repository passes", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--json"], {
      encoding: "utf8"
    });
    const { issues } = JSON.parse(out);
    assert.deepEqual(
      issues.filter((i) => i.level === "error"),
      []
    );
  });

  test("name, prefix and description", () => {
    write(
      SKILL_PATH,
      SKILL.replace("name: esp-demo", "name: demo").replace(
        /description: .*/,
        `description: ${"x".repeat(260)}`
      )
    );
    const messages = errors().map((i) => i.message);
    assert.ok(messages.some((m) => m.includes('does not match "esp-demo"')));
    assert.ok(messages.some((m) => m.includes('lacks the "esp-" prefix')));
    assert.ok(messages.some((m) => m.includes("truncates at 250")));
  });

  test("sections: optional marker, order, missing", () => {
    write(
      SKILL_PATH,
      SKILL.replace(
        "## Additional Resources",
        "## Additional Resources (optional)"
      )
        .replace("## Core Principles\n\n- Be clear\n\n", "")
        .replace(
          "## Output Guidance",
          "## Templates\n\nx\n\n## Output Guidance"
        )
    );
    const messages = errors().map((i) => i.message);
    assert.ok(messages.some((m) => m.includes('drop the "(optional)" marker')));
    assert.ok(
      messages.some((m) =>
        m.includes('missing required section: "## Core Principles"')
      )
    );
    assert.ok(messages.some((m) => m.includes("out of template order")));
  });

  test("arguments: hint mismatch, reserved and plugin-wide letters, positional", () => {
    write(
      SKILL_PATH,
      SKILL.replace('[-n|--dry-run]"', '[-n|--dry-run]"')
        .replace(
          '[-t|--type <type>] [-r|--reviewers <name>...] [context]"',
          '[-t|--type <type>] [-f|--fast] [-p|--plan <mode>] [context]"'
        )
        .replace("1. Do it.", "1. Use $1. Do it.")
    );
    const messages = errors().map((i) => i.message);
    assert.ok(
      messages.some((m) => m.includes("argument-hint and Definitions differ"))
    );
    assert.ok(messages.some((m) => m.includes("-f is reserved for --force")));
    assert.ok(messages.some((m) => m.includes("-p|--plan takes a <path>")));
    assert.ok(messages.some((m) => m.includes("positional substitution")));
  });

  test("an option without a short name is rejected", () => {
    write(
      SKILL_PATH,
      SKILL.replace("[-n|--dry-run] [-t", "[--dry-run] [-t").replace(
        "**`[-n|--dry-run]`**",
        "**`[--dry-run]`**"
      )
    );
    assert.ok(
      errors().some((i) => i.message.includes("needs -x|--long-name form"))
    );
  });

  test("resources, guidelines, leftovers and links", () => {
    write(
      SKILL_PATH,
      SKILL.replace(": read it before step 1", "")
        .replace("### Rules\n", "Loose text\n\n### Rules\n")
        .replace(
          "Demo.\n",
          "Demo {{todo}}.\n\n<!-- Instructions -->\n\nSee [missing](references/missing.md).\n"
        )
    );
    const found = rules();
    for (const rule of [
      "resources",
      "section",
      "placeholder",
      "comment",
      "link"
    ]) {
      assert.ok(found.includes(rule), `expected a ${rule} error`);
    }
  });

  test("ascii allows functional emojis only", () => {
    write(SKILL_PATH, SKILL.replace("- Be clear", "- Be clear \u{1F534} café"));
    const ascii = errors().filter((i) => i.rule === "ascii");
    assert.equal(ascii.length, 1);
    assert.match(ascii[0].message, /\\u00e9|é/);
  });

  test("agent frontmatter and sections", () => {
    write(
      "plugins/esp-demo/agents/esp-helper.md",
      AGENT.replace("model: sonnet", "model: gpt")
        .replace("color: blue\n", "")
        .replace("## Knowledge Base\n\nx\n\n", "")
    );
    const messages = errors().map((i) => i.message);
    assert.ok(messages.some((m) => m.includes("unknown model: gpt")));
    assert.ok(messages.some((m) => m.includes("missing `color`")));
    assert.ok(messages.some((m) => m.includes('"## Knowledge Base"')));
  });

  test("readme prompt sections follow the plugin content", () => {
    write(
      "plugins/esp-demo/README.md",
      README.replace("## Agents\n\nx\n\n", "").replace(
        "## Complete Examples",
        "## Hooks\n\nx\n\n## Complete Examples"
      )
    );
    const messages = errors().map((i) => i.message);
    assert.ok(messages.some((m) => m.includes('no "## Agents"')));
    assert.ok(
      messages.some((m) => m.includes('"## Hooks" but the plugin has none'))
    );
  });

  test("registration and marketplace", () => {
    write(
      "plugins/esp-demo/.claude-plugin/plugin.json",
      JSON.stringify({ skills: ["./skills/demo/gone", "./skills/demo/gone"] })
    );
    write(
      ".claude-plugin/marketplace.json",
      JSON.stringify({ plugins: [{ name: "b" }, { name: "a" }] })
    );
    const messages = errors().map((i) => i.message);
    assert.ok(messages.some((m) => m.includes("listed twice")));
    assert.ok(messages.some((m) => m.includes("has no SKILL.md")));
    assert.ok(
      messages.some((m) =>
        m.includes("skill not listed: ./skills/demo/esp-demo")
      )
    );
    assert.ok(messages.some((m) => m.includes("alphabetical order")));
  });

  test("workflows are counted", () => {
    assert.equal(validate(root).counts.workflows, 1);
  });

  test("workflow meta must come first and be a pure literal", () => {
    const messages = (text) => {
      write(WORKFLOW_PATH, text);
      return errors().map((i) => i.message);
    };
    assert.ok(
      messages(
        WORKFLOW.replace("count: -1", "count: LIMIT").replace(
          "// A demo workflow.",
          "const LIMIT = 1;"
        )
      ).some((m) => m.includes("must begin with `export const meta"))
    );
    assert.ok(
      messages(WORKFLOW.replace("count: -1", "count: LIMIT")).some((m) =>
        m.includes("pure literal; found `LIMIT`")
      )
    );
    for (const value of ["String(1)", "`n${1}`", "...BASE"]) {
      assert.ok(
        messages(WORKFLOW.replace("count: -1", `count: ${value}`)).some((m) =>
          m.includes("pure literal")
        ),
        `expected ${value} to be rejected`
      );
    }
    assert.ok(
      messages(
        WORKFLOW.replace(
          '  description: "Demo workflow. Run it to test the validator.",\n',
          ""
        ).replace('name: "esp-flow"', 'name: "flow"')
      ).some((m) => m.includes("meta needs a `description`"))
    );
    const named = messages(
      WORKFLOW.replace('name: "esp-flow"', 'name: "flow"')
    );
    assert.ok(named.some((m) => m.includes('does not match "esp-flow"')));
    assert.ok(named.some((m) => m.includes('lacks the "esp-" prefix')));
  });

  test("workflow phases, forbidden calls and agent types", () => {
    write(
      WORKFLOW_PATH,
      WORKFLOW.replace('phase("Work");', 'phase("Work");\nphase("Later");')
        .replace(
          "return {",
          "const t = Date.now() + Math.random();\nconst d = new Date();\nconst m = await import('x');\nreturn {"
        )
        .replace('"esp-demo:esp-helper"', '"esp-helper"')
        .replace('"general-purpose"', '"esp-demo:esp-missing"')
    );
    const found = errors();
    const messages = found.map((i) => i.message);
    assert.ok(found.every((i) => i.rule === "workflow"));
    assert.ok(messages.includes('phase "Later" is not in meta.phases'));
    assert.ok(messages.some((m) => m.startsWith("Date.now()")));
    assert.ok(messages.some((m) => m.startsWith("Math.random()")));
    assert.ok(messages.some((m) => m.startsWith("new Date()")));
    assert.ok(messages.some((m) => m.startsWith("dynamic import()")));
    assert.ok(
      messages.includes(
        'agentType needs the plugin namespace: "esp-demo:esp-helper"'
      )
    );
    assert.ok(
      messages.some((m) => m.includes('"esp-demo:esp-missing" names no agent'))
    );
    assert.equal(messages.length, 7, messages.join("\n"));
  });

  test("the CLI exits 1 on errors and 2 on a usage error", () => {
    write(SKILL_PATH, SKILL.replace("name: esp-demo", "name: other"));
    const run = (args) => {
      try {
        execFileSync(process.execPath, [SCRIPT, ...args], {
          encoding: "utf8",
          stdio: "pipe"
        });
        return 0;
      } catch (e) {
        return e.status;
      }
    };
    assert.equal(run(["--root", root]), 1);
    assert.equal(run(["--bogus"]), 2);
  });
});

describe("strict frontmatter yaml", () => {
  const yaml = (text) => parseYaml(text.split("\n"));
  const messages = (text) => yaml(text).errors.map((e) => e.message);

  test("parseYaml reads plain, quoted, flow, block and nested values", () => {
    const { fields, errors } = yaml(
      [
        "name: esp-demo",
        'hint: "[-t|--type <type>] say \\"hi\\""',
        "single: 'it''s: fine'",
        "tools: [Read, Grep]",
        "description: >-",
        "  Folded over",
        "  two lines.",
        "metadata:",
        "  author: someone"
      ].join("\n")
    );
    assert.deepEqual(errors, []);
    assert.equal(fields.name.value, "esp-demo");
    assert.equal(fields.hint.value, '[-t|--type <type>] say "hi"');
    assert.equal(fields.single.value, "it's: fine");
    assert.equal(fields.tools.value, "[Read, Grep]");
    assert.equal(fields.description.value, "Folded over two lines.");
    assert.equal(fields.description.line, 5);
  });

  test("parseYaml rejects what a strict parser rejects or reads differently", () => {
    assert.match(messages("description: Runs a loop: picks one")[0], /: /);
    assert.match(messages("description: Fix it now #later")[0], / #/);
    assert.match(messages("description: *bold* start")[0], /indicator/);
    assert.match(messages("description: - a list?")[0], /indicator/);
    assert.match(messages('hint: "open')[0], /double-quoted/);
    assert.match(messages("hint: 'it's'")[0], /single-quoted/);
    assert.match(messages("tools: [Read, Grep")[0], /flow/);
    assert.match(messages("name: a\n\tdescription: b")[0], /tab/);
    assert.match(messages("name: a\nname: b")[0], /duplicate/);
    assert.match(messages("  orphan: line")[0], /outside a block/);
    assert.match(messages("not yaml at all")[0], /key: value/);
    assert.deepEqual(messages("description: plain text, with commas"), []);
  });

  test("parseYaml checks nested mappings and sequences at any depth", () => {
    assert.match(
      messages("metadata:\n  author: Someone: invalid")[0],
      /`author`: contains `: `/
    );
    assert.match(
      messages("interface:\n  display_name: ESP: Demo")[0],
      /`display_name`/
    );
    assert.match(messages("paths:\n  - *.md")[0], /item: .*indicator/);
    assert.match(messages("a:\n    b: 1\n  c: 2")[0], /inconsistent/);
    assert.match(messages("a:\n  b: 1\n  - c")[0], /mixed/);
    const { fields, errors } = yaml(
      [
        "hooks:",
        "  PreToolUse:",
        '    - matcher: "Bash"',
        "      hooks:",
        "        - type: command",
        "paths:",
        '  - "src/**"',
        "  - docs/*.md",
        "policy:",
        "  allow_implicit_invocation: false"
      ].join("\n")
    );
    assert.deepEqual(errors, []);
    assert.equal(
      fields.hooks.children.PreToolUse.items[0].children.matcher.value,
      "Bash"
    );
    assert.deepEqual(
      fields.paths.items.map((i) => i.value),
      ["src/**", "docs/*.md"]
    );
    assert.equal(fields.policy.children.allow_implicit_invocation.raw, "false");
  });

  test("a skill with an unquoted colon fails, and a folded description is measured", () => {
    write(
      SKILL_PATH,
      SKILL.replace(
        /description: .*/,
        "description: Demo skill: use to test the validator."
      )
    );
    assert.deepEqual(rules(), ["yaml"]);
    write(
      SKILL_PATH,
      SKILL.replace(/description: .*/, `description: >-\n  ${"x".repeat(260)}`)
    );
    assert.ok(errors().some((i) => i.message.includes("truncates at 250")));
  });

  test("an agent frontmatter is checked too", () => {
    write(
      "plugins/esp-demo/agents/esp-helper.md",
      AGENT.replace(
        "description: Helps with one task",
        "description: Helps: one task"
      )
    );
    assert.deepEqual(rules(), ["yaml"]);
  });
});

describe("codex metadata", () => {
  const META = "plugins/esp-demo/skills/demo/esp-demo/agents/openai.yaml";
  const userInvoked = () =>
    write(
      SKILL_PATH,
      SKILL.replace("---\n\n#", "disable-model-invocation: true\n---\n\n#")
    );
  const codex = () => validate(root).issues.filter((i) => i.rule === "codex");
  const policy = (value) =>
    `interface:\n  display_name: "Demo"\npolicy:\n  allow_implicit_invocation: ${value}\n`;

  test("readImplicitPolicy reads the policy key, nested or flow", () => {
    assert.equal(readImplicitPolicy(policy("false")), "false");
    assert.equal(
      readImplicitPolicy("policy: {allow_implicit_invocation: false}\n"),
      "false"
    );
    assert.equal(
      readImplicitPolicy("other:\n  allow_implicit_invocation: false\n"),
      undefined
    );
  });

  test("a flow-mapping policy is held to the invocation mode", () => {
    write(META, "policy: {allow_implicit_invocation: false}\n");
    assert.match(codex()[0].message, /hides a model-invoked skill/);
    userInvoked();
    assert.deepEqual(codex(), []);
  });

  test("a nested metadata value with an unquoted colon fails", () => {
    write(
      META,
      `interface:\n  display_name: ESP: Demo\n${policy("true").slice(32)}`
    );
    assert.ok(errors().some((i) => i.file === META && i.rule === "yaml"));
  });

  test("a user-invoked skill without the file warns", () => {
    userInvoked();
    assert.deepEqual(
      codex().map((i) => i.level),
      ["warn"]
    );
    assert.deepEqual(errors(), []);
  });

  test("the policy must match the invocation mode", () => {
    userInvoked();
    write(META, policy("false"));
    assert.deepEqual(codex(), []);
    write(META, policy("true"));
    assert.match(
      codex()[0].message,
      /set policy.allow_implicit_invocation: false/
    );
    write(SKILL_PATH, SKILL);
    write(META, policy("false"));
    assert.match(codex()[0].message, /hides a model-invoked skill/);
    write(META, policy("maybe"));
    assert.match(codex()[0].message, /true or false/);
  });

  test("the metadata file parses strictly", () => {
    write(META, 'interface:\n  display_name: "Demo"\n\tpolicy: x\n');
    assert.ok(errors().some((i) => i.file === META && i.rule === "yaml"));
  });
});
