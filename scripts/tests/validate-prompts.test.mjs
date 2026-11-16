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
  write(
    "plugins/esp-demo/af-workflows/go.yaml",
    "steps:\n  - type: skill\n    skill: esp-demo:esp-demo\n"
  );
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

  test("registration, workflows and marketplace", () => {
    write(
      "plugins/esp-demo/.claude-plugin/plugin.json",
      JSON.stringify({ skills: ["./skills/demo/gone", "./skills/demo/gone"] })
    );
    write(
      "plugins/esp-demo/af-workflows/go.yaml",
      "steps:\n  - skill: esp-demo\n"
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
    assert.ok(messages.some((m) => m.includes("needs the plugin namespace")));
    assert.ok(messages.some((m) => m.includes("alphabetical order")));
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
