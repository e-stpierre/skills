#!/usr/bin/env node
// Validate the prompt files of the repository against their templates:
// skills, agents, plugin READMEs, plugin skill registration and marketplace
// order. Section names, order and required
// sections are read from the templates; the argument conventions mirror
// esp-create-skill. Judgment checks (description quality, done-conditions)
// stay with the /normalize skill.
//
// Usage: node scripts/validate-prompts.mjs [--root <dir>] [--json]
// Exit codes: 0 no error (warnings allowed), 1 errors found, 2 usage error.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATES = {
  skill:
    "plugins/esp-skills/skills/authoring/esp-create-skill/references/action-skill-template.md",
  agent: "docs/templates/agent-template.md",
  readme: "docs/templates/readme-template.md"
};

const RESERVED = {
  h: ["help"],
  v: ["verbose"],
  q: ["quiet"],
  f: ["force"],
  o: ["output"],
  n: ["dry-run"],
  y: ["yes"]
};

const PLUGIN_WIDE = {
  d: ["run-dir"],
  i: ["interactive"],
  r: ["reviewers"],
  p: ["pr", "plan"],
  u: ["resume"]
};

const MODELS = ["sonnet", "opus", "haiku", "fable", "inherit"];
const COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan"
];
const MAX_SKILL_LINES = 500;
const MAX_DESCRIPTION = 250;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "local", "in-progress"]);

// ---------------------------------------------------------------- parsing

/** Split a markdown file into lines, flagging the lines inside code fences. */
export function scanLines(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let fence = null;
  for (const [i, raw] of lines.entries()) {
    const m = raw.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const closes =
        m &&
        m[1][0] === fence[0] &&
        m[1].length >= fence.length &&
        !m[2].trim();
      out.push({ n: i + 1, text: raw, code: true });
      if (closes) fence = null;
    } else if (m) {
      fence = m[1];
      out.push({ n: i + 1, text: raw, code: true });
    } else {
      out.push({ n: i + 1, text: raw, code: false });
    }
  }
  return out;
}

/** Remove inline code spans so their content is not read as markdown. */
export function stripInlineCode(line) {
  return line.replace(/(`+)(.+?)\1/g, "");
}

/** Parse a `---` frontmatter block that must start on line 1. */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const fields = {};
  const blank = [];
  for (let i = 1; i < end; i++) {
    if (!lines[i].trim()) blank.push(i + 1);
    const m = lines[i].match(/^([A-Za-z][\w-]*):\s?(.*)$/);
    if (m) fields[m[1]] = { raw: m[2], line: i + 1 };
  }
  return { fields, end: end + 1, blank };
}

function unquote(value) {
  const m = value.match(/^"(.*)"$|^'(.*)'$/);
  return m ? (m[1] ?? m[2]) : value;
}

/** Headings of one level, outside code fences. */
export function headings(scanned, level) {
  const prefix = "#".repeat(level) + " ";
  return scanned
    .filter((l) => !l.code && l.text.startsWith(prefix))
    .map((l) => ({ name: l.text.slice(prefix.length).trim(), line: l.n }));
}

/** Read the template headings and the REQUIRED SECTIONS list of its header. */
export function parseTemplate(text) {
  const order = headings(scanLines(text), 2).map((h) =>
    h.name.replace(/\s*\(optional\)$/, "")
  );
  const optional = headings(scanLines(text), 2)
    .filter((h) => /\(optional\)$/.test(h.name))
    .map((h) => h.name.replace(/\s*\(optional\)$/, ""));
  const required = [];
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^REQUIRED SECTIONS/.test(l));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const m = line.match(/^(?:-|\d+\.)\s+(.+)$/);
      if (!m) break;
      required.push(m[1].split(/\s+-\s+|\s*\(/)[0].trim());
    }
  }
  return { order, optional, required };
}

/** Split an argument-hint into its tokens: `-t|--type <type>` is one token. */
export function hintTokens(hint) {
  const raw = [];
  let depth = 0;
  let cur = "";
  for (const ch of hint) {
    if (ch === "[" || ch === "<") depth++;
    if (ch === "]" || ch === ">") depth--;
    if (ch === " " && depth === 0) {
      if (cur) raw.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) raw.push(cur);
  const tokens = [];
  for (const t of raw) {
    const prev = tokens[tokens.length - 1];
    if (t.startsWith("<") && prev && prev.startsWith("-")) {
      tokens[tokens.length - 1] = `${prev} ${t}`;
    } else tokens.push(t);
  }
  return tokens;
}

/** Parse one hint token into an option, a positional, or an invalid option. */
export function parseToken(token) {
  const inner = token.replace(/^\[(.*)\]$/, "$1");
  if (!inner.startsWith("-")) return { kind: "positional", token };
  const m = inner.match(
    /^-([A-Za-z])\|--([a-z0-9-]+)(?: (<[^>]+>)(\.\.\.)?)?$/
  );
  if (!m) return { kind: "invalid", token };
  return {
    kind: "option",
    token,
    short: m[1],
    long: m[2],
    value: m[3] ?? null
  };
}

/** Lines of a `##` section, outside code fences, without the heading. */
function sectionLines(scanned, name) {
  const start = scanned.findIndex((l) => !l.code && l.text === `## ${name}`);
  if (start < 0) return [];
  const rest = scanned.slice(start + 1);
  const end = rest.findIndex((l) => !l.code && /^## /.test(l.text));
  return end < 0 ? rest : rest.slice(0, end);
}

// ------------------------------------------------------------------ checks

function issue(list, file, line, rule, message, level = "error") {
  list.push({ file, line, rule, message, level });
}

/** Non-ASCII characters other than functional emojis. */
function checkAscii(issues, file, text, allowEmoji) {
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    for (const ch of line) {
      if (ch.charCodeAt(0) < 128) continue;
      const emoji =
        /\p{Extended_Pictographic}/u.test(ch) || ch === "️" || ch === "‍";
      if (allowEmoji && emoji) continue;
      issue(
        issues,
        file,
        i + 1,
        "ascii",
        `non-ASCII character ${JSON.stringify(ch)}`
      );
      break;
    }
  }
}

/** Relative markdown links that do not resolve. */
function checkLinks(issues, root, file, scanned) {
  for (const l of scanned) {
    if (l.code) continue;
    for (const m of stripInlineCode(l.text).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = resolve(dirname(join(root, file)), target.split("#")[0]);
      if (!existsSync(path)) {
        issue(issues, file, l.n, "link", `link target not found: ${target}`);
      }
    }
  }
}

/** Template placeholders and instruction comments left in the file. */
function checkLeftovers(issues, file, scanned) {
  for (const l of scanned) {
    if (l.code) continue;
    const text = stripInlineCode(l.text);
    if (text.includes("{{")) {
      issue(
        issues,
        file,
        l.n,
        "placeholder",
        "template placeholder left in the file"
      );
    }
    if (/<!--(?!\s*markdownlint)/.test(text)) {
      issue(
        issues,
        file,
        l.n,
        "comment",
        "template instruction comment left in the file"
      );
    }
  }
}

/** Section names, order and required sections against a template. */
function checkSections(issues, file, found, template, required) {
  let last = -1;
  for (const h of found) {
    if (/\(optional\)$/.test(h.name)) {
      issue(
        issues,
        file,
        h.line,
        "section",
        `drop the "(optional)" marker: "## ${h.name}"`
      );
      continue;
    }
    const idx = template.order.indexOf(h.name);
    if (idx < 0) {
      issue(
        issues,
        file,
        h.line,
        "section",
        `section not in the template: "## ${h.name}"`
      );
      continue;
    }
    if (idx < last) {
      issue(
        issues,
        file,
        h.line,
        "section",
        `section out of template order: "## ${h.name}"`
      );
    }
    last = Math.max(last, idx);
  }
  const names = found.map((h) => h.name);
  for (const name of required) {
    if (!names.includes(name)) {
      issue(
        issues,
        file,
        1,
        "section",
        `missing required section: "## ${name}"`
      );
    }
  }
}

function checkName(issues, file, fm, expected, prefix) {
  const name = fm.fields.name ? unquote(fm.fields.name.raw) : "";
  const line = fm.fields.name?.line ?? 1;
  if (!name) return issue(issues, file, 1, "frontmatter", "missing `name`");
  if (!KEBAB.test(name) || name.length > 64) {
    issue(
      issues,
      file,
      line,
      "frontmatter",
      `name is not kebab-case (max 64): ${name}`
    );
  }
  if (name !== expected) {
    issue(
      issues,
      file,
      line,
      "frontmatter",
      `name "${name}" does not match "${expected}"`
    );
  }
  if (prefix && !name.startsWith(prefix)) {
    issue(
      issues,
      file,
      line,
      "frontmatter",
      `name lacks the "${prefix}" prefix`
    );
  }
}

function checkDescription(issues, file, fm) {
  const d = fm.fields.description;
  if (!d || !unquote(d.raw).trim()) {
    return issue(issues, file, 1, "frontmatter", "missing `description`");
  }
  const len = unquote(d.raw).length;
  if (len > MAX_DESCRIPTION) {
    issue(
      issues,
      file,
      d.line,
      "frontmatter",
      `description is ${len} characters; the listing truncates at ${MAX_DESCRIPTION}`
    );
  }
}

/** Argument-hint, Definitions and option letters of a skill. */
function checkArguments(issues, file, fm, scanned, pluginSkill) {
  const hintField = fm.fields["argument-hint"];
  const hasSection = scanned.some((l) => !l.code && l.text === "## Arguments");
  if (!hintField && !hasSection) return;
  if (!hintField) {
    return issue(
      issues,
      file,
      1,
      "arguments",
      "Arguments section without `argument-hint`"
    );
  }
  if (!/^".*"$/.test(hintField.raw)) {
    issue(
      issues,
      file,
      hintField.line,
      "arguments",
      "argument-hint is not quoted"
    );
  }
  if (!hasSection) {
    return issue(
      issues,
      file,
      hintField.line,
      "arguments",
      "argument-hint without an Arguments section"
    );
  }
  const section = sectionLines(scanned, "Arguments");
  const subs = section
    .filter((l) => /^### /.test(l.text))
    .map((l) => l.text.slice(4));
  if (subs[0] !== "Definitions" || subs[1] !== "Values") {
    issue(
      issues,
      file,
      1,
      "arguments",
      "Arguments needs ### Definitions then ### Values"
    );
  }
  if (!section.some((l) => l.text === "Arguments: $ARGUMENTS")) {
    issue(
      issues,
      file,
      1,
      "arguments",
      "Values must hold `Arguments: $ARGUMENTS`"
    );
  }

  const tokens = hintTokens(unquote(hintField.raw));
  const defs = [];
  let inDefs = false;
  for (const l of section) {
    if (/^### /.test(l.text)) inDefs = l.text === "### Definitions";
    const m = inDefs && l.text.match(/^- \*\*`([^`]+)`\*\*/);
    if (m) defs.push({ token: m[1], line: l.n });
  }
  if (tokens.join(" ") !== defs.map((d) => d.token).join(" ")) {
    issue(
      issues,
      file,
      hintField.line,
      "arguments",
      `argument-hint and Definitions differ: "${tokens.join(" ")}" vs "${defs
        .map((d) => d.token)
        .join(" ")}"`
    );
  }

  const shorts = new Map();
  for (const t of tokens.map(parseToken)) {
    if (t.kind === "invalid") {
      issue(
        issues,
        file,
        hintField.line,
        "arguments",
        `option needs -x|--long-name form: ${t.token}`
      );
      continue;
    }
    if (t.kind !== "option") continue;
    if (shorts.has(t.short)) {
      issue(
        issues,
        file,
        hintField.line,
        "arguments",
        `short name -${t.short} used twice`
      );
    }
    shorts.set(t.short, t.long);
    const tables = pluginSkill ? [RESERVED, PLUGIN_WIDE] : [RESERVED];
    for (const table of tables) {
      const meaning = table[t.short];
      if (meaning && !meaning.includes(t.long)) {
        issue(
          issues,
          file,
          hintField.line,
          "arguments",
          `-${t.short} is reserved for --${meaning.join(" or --")}, not --${t.long}`
        );
      }
      for (const [letter, longs] of Object.entries(table)) {
        if (longs.includes(t.long) && letter !== t.short) {
          issue(
            issues,
            file,
            hintField.line,
            "arguments",
            `--${t.long} must use -${letter}`
          );
        }
      }
    }
    if (
      pluginSkill &&
      t.short === "p" &&
      t.long === "plan" &&
      t.value !== "<path>"
    ) {
      issue(
        issues,
        file,
        hintField.line,
        "arguments",
        "-p|--plan takes a <path>"
      );
    }
  }

  for (const l of scanned) {
    if (!l.code && /\$ARGUMENTS\[\d+\]|\$\d\b/.test(stripInlineCode(l.text))) {
      issue(
        issues,
        file,
        l.n,
        "arguments",
        "positional substitution; read options by name"
      );
    }
  }
}

/** Each Additional Resources link states when to read it. */
function checkResources(issues, file, scanned) {
  let parentReads = false;
  for (const l of sectionLines(scanned, "Additional Resources")) {
    const m = l.text.match(/^(\s*)- (.*)$/);
    if (!m) continue;
    const reads = /\bread\b/i.test(m[2]);
    if (!m[1]) parentReads = reads;
    if (/\]\(/.test(m[2]) && !reads && !(m[1] && parentReads)) {
      issue(
        issues,
        file,
        l.n,
        "resources",
        "link has no when-to-read condition"
      );
    }
  }
}

/** Skill-Specific Guidelines content lives in ### subsections. */
function checkGuidelines(issues, file, scanned) {
  const section = sectionLines(scanned, "Skill-Specific Guidelines");
  for (const l of section) {
    if (/^### /.test(l.text)) return;
    if (l.text.trim()) {
      return issue(
        issues,
        file,
        l.n,
        "section",
        "Skill-Specific Guidelines content must sit in ### subsections"
      );
    }
  }
}

/** A markdown table outside code fences (allowed only for a true grid). */
function checkTables(issues, file, scanned) {
  for (const [i, l] of scanned.entries()) {
    const next = scanned[i + 1];
    if (
      !l.code &&
      /^\s*\|.*\|\s*$/.test(l.text) &&
      next &&
      /^\s*\|[\s:|-]+\|\s*$/.test(next.text)
    ) {
      issue(
        issues,
        file,
        l.n,
        "table",
        "table: use a list unless this is a true grid",
        "warn"
      );
    }
  }
}

export function validateSkill(root, file, template) {
  const issues = [];
  const text = readFileSync(join(root, file), "utf8");
  const scanned = scanLines(text);
  const fm = parseFrontmatter(text);
  const parts = file.split(/[\\/]/);
  const pluginSkill = parts[0] === "plugins";
  if (!fm) {
    issue(issues, file, 1, "frontmatter", "frontmatter must start on line 1");
    return issues;
  }
  for (const n of fm.blank)
    issue(issues, file, n, "frontmatter", "blank line inside the frontmatter");
  const prefix = pluginSkill ? `${parts[1].split("-")[0]}-` : null;
  checkName(issues, file, fm, basename(dirname(file)), prefix);
  checkDescription(issues, file, fm);
  checkArguments(issues, file, fm, scanned, pluginSkill);
  const found = headings(scanned, 2);
  const required = template.required.filter(
    (s) => s !== "Arguments" || fm.fields["argument-hint"]
  );
  checkSections(issues, file, found, template, required);
  checkGuidelines(issues, file, scanned);
  checkResources(issues, file, scanned);
  checkTables(issues, file, scanned);
  checkLeftovers(issues, file, scanned);
  checkLinks(issues, root, file, scanned);
  checkAscii(issues, file, text, true);
  const count = text.split(/\r?\n/).length;
  if (count > MAX_SKILL_LINES) {
    issue(
      issues,
      file,
      MAX_SKILL_LINES,
      "size",
      `${count} lines; keep SKILL.md under ${MAX_SKILL_LINES}`
    );
  }
  return issues;
}

export function validateAgent(root, file, template) {
  const issues = [];
  const text = readFileSync(join(root, file), "utf8");
  const scanned = scanLines(text);
  const fm = parseFrontmatter(text);
  if (!fm) {
    issue(issues, file, 1, "frontmatter", "frontmatter must start on line 1");
    return issues;
  }
  for (const n of fm.blank)
    issue(issues, file, n, "frontmatter", "blank line inside the frontmatter");
  const plugin = file.split(/[\\/]/)[1];
  checkName(
    issues,
    file,
    fm,
    basename(file, ".md"),
    `${plugin.split("-")[0]}-`
  );
  checkDescription(issues, file, fm);
  for (const key of ["tools", "model", "color"]) {
    if (!fm.fields[key])
      issue(issues, file, 1, "frontmatter", `missing \`${key}\``);
  }
  const model = fm.fields.model && unquote(fm.fields.model.raw);
  if (model && !MODELS.includes(model) && !/^claude-/.test(model)) {
    issue(
      issues,
      file,
      fm.fields.model.line,
      "frontmatter",
      `unknown model: ${model}`
    );
  }
  const color = fm.fields.color && unquote(fm.fields.color.raw);
  if (color && !COLORS.includes(color)) {
    issue(
      issues,
      file,
      fm.fields.color.line,
      "frontmatter",
      `unknown color: ${color}`
    );
  }
  checkSections(
    issues,
    file,
    headings(scanned, 2),
    template,
    template.required
  );
  checkLeftovers(issues, file, scanned);
  checkLinks(issues, root, file, scanned);
  checkAscii(issues, file, text, true);
  return issues;
}

export function validateReadme(root, file, template, plugin) {
  const issues = [];
  const text = readFileSync(join(root, file), "utf8");
  const scanned = scanLines(text);
  if (!/^# /.test(text))
    issue(
      issues,
      file,
      1,
      "section",
      "README must start with `# <Plugin Name>`"
    );
  const found = headings(scanned, 2);
  checkSections(
    issues,
    file,
    found,
    template,
    template.required.filter((s) => s !== "Title")
  );
  const names = found.map((h) => h.name);
  const has = {
    Agents: plugin.agents.length > 0,
    Skills: plugin.skills.length > 0,
    Hooks: existsSync(join(root, plugin.dir, "hooks"))
  };
  for (const [section, present] of Object.entries(has)) {
    if (present && !names.includes(section)) {
      issue(
        issues,
        file,
        1,
        "section",
        `plugin has ${section.toLowerCase()} but no "## ${section}"`
      );
    }
    if (!present && names.includes(section)) {
      issue(
        issues,
        file,
        1,
        "section",
        `"## ${section}" but the plugin has none`
      );
    }
  }
  checkLinks(issues, root, file, scanned);
  checkAscii(issues, file, text, true);
  return issues;
}

/** Every shipped skill is listed in plugin.json, and every entry exists. */
export function validateRegistration(root, plugin) {
  const issues = [];
  const file = join(plugin.dir, ".claude-plugin", "plugin.json")
    .split(sep)
    .join("/");
  if (!existsSync(join(root, file))) return issues;
  const manifest = JSON.parse(readFileSync(join(root, file), "utf8"));
  if (!Array.isArray(manifest.skills)) return issues;
  const listed = manifest.skills.map((s) => s.replace(/\/$/, ""));
  const seen = new Set();
  for (const entry of listed) {
    if (seen.has(entry))
      issue(issues, file, 1, "registration", `listed twice: ${entry}`);
    seen.add(entry);
    if (!existsSync(join(root, plugin.dir, entry, "SKILL.md"))) {
      issue(
        issues,
        file,
        1,
        "registration",
        `listed path has no SKILL.md: ${entry}`
      );
    }
  }
  for (const skill of plugin.skills) {
    const entry = `./${relative(
      join(root, plugin.dir),
      join(root, dirname(skill))
    )
      .split(sep)
      .join("/")}`;
    if (!seen.has(entry))
      issue(issues, file, 1, "registration", `skill not listed: ${entry}`);
  }
  return issues;
}

export function validateMarketplace(root) {
  const issues = [];
  const file = ".claude-plugin/marketplace.json";
  if (!existsSync(join(root, file))) return issues;
  const names = (
    JSON.parse(readFileSync(join(root, file), "utf8")).plugins ?? []
  ).map((p) => p.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (names.join() !== sorted.join()) {
    issue(
      issues,
      file,
      1,
      "marketplace",
      "plugins are not in alphabetical order by name"
    );
  }
  return issues;
}

// --------------------------------------------------------------- discovery

function walk(root, dir, out = []) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    if (SKIP_DIRS.has(entry)) continue;
    const rel = dir ? `${dir}/${entry}` : entry;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
  return out;
}

export function discover(root) {
  const plugins = existsSync(join(root, "plugins"))
    ? readdirSync(join(root, "plugins"))
        .filter((p) => statSync(join(root, "plugins", p)).isDirectory())
        .map((p) => {
          const dir = `plugins/${p}`;
          const files = walk(root, dir);
          return {
            name: p,
            dir,
            skills: files.filter(
              (f) => f.startsWith(`${dir}/skills/`) && f.endsWith("/SKILL.md")
            ),
            agents: files.filter(
              (f) =>
                /\/agents\/[^/]+\.md$/.test(f) && f.startsWith(`${dir}/agents/`)
            ),
            readme: existsSync(join(root, dir, "README.md"))
              ? `${dir}/README.md`
              : null
          };
        })
    : [];
  const repoSkills = walk(root, ".claude/skills").filter((f) =>
    f.endsWith("/SKILL.md")
  );
  return { plugins, repoSkills };
}

export function validate(root) {
  const templates = Object.fromEntries(
    Object.entries(TEMPLATES).map(([k, path]) => [
      k,
      parseTemplate(readFileSync(join(root, path), "utf8"))
    ])
  );
  const { plugins, repoSkills } = discover(root);
  const issues = [];
  const counts = {
    skills: repoSkills.length,
    agents: 0,
    readmes: 0
  };
  for (const f of repoSkills)
    issues.push(...validateSkill(root, f, templates.skill));
  for (const p of plugins) {
    counts.skills += p.skills.length;
    counts.agents += p.agents.length;
    for (const f of p.skills)
      issues.push(...validateSkill(root, f, templates.skill));
    for (const f of p.agents)
      issues.push(...validateAgent(root, f, templates.agent));
    if (p.readme) {
      counts.readmes++;
      issues.push(...validateReadme(root, p.readme, templates.readme, p));
    }
    issues.push(...validateRegistration(root, p));
  }
  issues.push(...validateMarketplace(root));
  return { issues, counts };
}

// --------------------------------------------------------------------- CLI

function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = resolve(argv[++i] ?? "");
    else if (argv[i] === "--json") json = true;
    else {
      process.stderr.write(
        `Unknown argument: ${argv[i]}\nUsage: validate-prompts.mjs [--root <dir>] [--json]\n`
      );
      return 2;
    }
  }
  const { issues, counts } = validate(root);
  const errors = issues.filter((i) => i.level === "error").length;
  if (json) {
    process.stdout.write(`${JSON.stringify({ counts, issues }, null, 2)}\n`);
  } else {
    for (const i of issues) {
      process.stdout.write(
        `${i.file}:${i.line}: [${i.level}] ${i.rule}: ${i.message}\n`
      );
    }
    process.stdout.write(
      `Checked ${counts.skills} skills, ${counts.agents} agents and ${counts.readmes} READMEs: ${errors} errors, ${issues.length - errors} warnings\n`
    );
  }
  return errors ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
