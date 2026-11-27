#!/usr/bin/env node
// Validate the prompt files of the repository against their templates:
// skills, agents, plugin READMEs, plugin workflow scripts, plugin skill
// registration and marketplace order. Section names, order and required
// sections are read from the templates; the argument conventions mirror
// esp-create-skill. Skill and shared reference files are scanned for links,
// and every plugin prompt file for Claude Code variables outside an
// "In Claude Code," line and for relative paths that do not resolve.
// Judgment checks (description quality, done-conditions) stay with the
// /normalize skill.
//
// Usage: node scripts/validate-prompts.mjs [--root <dir>] [--json]
// Exit codes: 0 no error (warnings allowed), 1 errors found, 2 usage error.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

export const TEMPLATES = {
  skill:
    "plugins/esp-skills/skills/authoring/esp-create-skill/references/action-skill-template.md",
  agent: "docs/templates/agent-template.md",
  readme: "docs/templates/readme-template.md"
};

const TEMPLATE_FILES = new Set(Object.values(TEMPLATES));

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
  const blank = [];
  for (let i = 1; i < end; i++) if (!lines[i].trim()) blank.push(i + 1);
  const { fields, errors } = parseYaml(lines.slice(1, end), 2);
  return { fields, end: end + 1, blank, yamlErrors: errors };
}

/** A YAML `key: value` line: the key, then the raw value (empty for a block). */
const KEY_LINE = /^([A-Za-z][\w-]*):(?:\s+(.*?))?\s*$/;

/**
 * Parse the strict YAML subset allowed in frontmatter and agent metadata:
 * `key: value` pairs with a plain, quoted or one-line flow value, a block
 * scalar (`|`, `>`), a nested mapping or a `- item` sequence, at any depth.
 * Every nested entry is checked like a top-level one. Anything a strict YAML
 * parser would reject or read differently is an error, so a harness that
 * parses strictly never drops the file. `first` is the line number of
 * lines[0]. Returns { fields, errors }: fields maps each top-level key to
 * { raw, value, line }, plus `children` (a nested mapping, same shape) or
 * `items` (a sequence of { raw, value, line }).
 */
export function parseYaml(lines, first = 1) {
  const fields = {};
  const errors = [];
  const stack = [{ indent: 0, map: fields, kind: null }];
  let pending = null; // a key with an empty value: its block may follow
  let scalar = null; // an open block scalar
  const closeScalar = () => {
    if (!scalar) return;
    scalar.field.value = scalar.parts.join(scalar.folded ? " " : "\n");
    scalar = null;
  };
  for (const [k, text] of lines.entries()) {
    const line = first + k;
    if (text.includes("\t")) {
      errors.push({ line, message: "tab character; indent with spaces" });
      continue;
    }
    if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.length - text.trimStart().length;
    const content = text.trim();
    if (scalar && indent > scalar.indent) {
      scalar.parts.push(content);
      continue;
    }
    closeScalar();
    if (pending && indent > pending.indent) {
      stack.push({ indent, map: null, kind: null, field: pending.field });
    }
    pending = null;
    let closed = false;
    while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
      stack.pop();
      closed = true;
    }
    const ctx = stack[stack.length - 1];
    if (indent !== ctx.indent) {
      const message =
        stack.length === 1 && !closed
          ? "indented line outside a block"
          : "inconsistent indentation";
      errors.push({ line, message });
      continue;
    }
    const item = content.match(/^-(?:\s+(.*))?$/);
    const kind = item ? "seq" : "map";
    if (ctx.kind && ctx.kind !== kind) {
      errors.push({ line, message: "mapping and sequence entries mixed" });
      continue;
    }
    if (!ctx.kind && ctx.field) {
      if (kind === "seq") ctx.field.items = [];
      else ctx.map = ctx.field.children = {};
    }
    if (!ctx.kind && !ctx.field && kind === "seq") {
      errors.push({ line, message: "sequence item outside a key" });
      continue;
    }
    ctx.kind = kind;
    if (!item) {
      keyLine(ctx, content, indent, line);
      continue;
    }
    const raw = item[1] ?? "";
    const entry = { raw, value: unquote(raw), line };
    ctx.field.items.push(entry);
    if (KEY_LINE.test(raw)) {
      // `- key: value` opens a mapping inside the sequence, at the key column
      const col = indent + content.length - raw.length;
      const sub = { indent: col, map: {}, kind: "map", field: entry };
      entry.children = sub.map;
      stack.push(sub);
      keyLine(sub, raw, col, line);
      continue;
    }
    const problem = raw ? yamlScalarProblem(raw) : "empty sequence item";
    if (problem) errors.push({ line, message: `item: ${problem}` });
  }
  /** One `key: value` entry of the mapping `ctx`, its key at column `col`. */
  function keyLine(ctx, content, col, line) {
    const m = content.match(KEY_LINE);
    if (!m) {
      errors.push({ line, message: `not a \`key: value\` line: ${content}` });
      return;
    }
    const [, key, raw = ""] = m;
    if (ctx.map[key]) {
      errors.push({ line, message: `duplicate key \`${key}\`` });
    }
    const field = { raw, value: raw, line };
    ctx.map[key] = field;
    if (!raw) {
      pending = { field, indent: col };
    } else if (/^[|>][+-]?\d?$/.test(raw)) {
      scalar = { field, indent: col, folded: raw[0] === ">", parts: [] };
    } else {
      const problem = yamlScalarProblem(raw);
      if (problem) errors.push({ line, message: `\`${key}\`: ${problem}` });
      else field.value = unquote(raw);
    }
  }
  closeScalar();
  return { fields, errors };
}

/** The `key: value` pairs of a one-line flow mapping (`{a: 1, b: 2}`), or null. */
export function flowMapping(raw) {
  const m = raw.match(/^\{(.*)\}$/);
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(",")) {
    const kv = part.trim().match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv) out[kv[1]] = { raw: kv[2].trim(), value: unquote(kv[2].trim()) };
  }
  return out;
}

/** Why a one-line YAML value would fail or change meaning, or null. */
function yamlScalarProblem(raw) {
  if (raw.startsWith('"')) {
    return /^"(?:[^"\\]|\\.)*"$/.test(raw)
      ? null
      : 'unbalanced or unescaped `"` in a double-quoted value';
  }
  if (raw.startsWith("'")) {
    return /^'(?:[^']|'')*'$/.test(raw)
      ? null
      : "unbalanced `'` in a single-quoted value (escape it as `''`)";
  }
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const close = raw[0] === "[" ? "]" : "}";
    return raw.endsWith(close) ? null : "flow value not closed on its line";
  }
  if (/^[&*!|>%@`]|^[-?:](\s|$)/.test(raw)) {
    return `starts with a YAML indicator (${raw[0]}); quote the value`;
  }
  if (/:\s|:$/.test(raw)) return "contains `: `; quote the value";
  if (/\s#/.test(raw))
    return "contains ` #`, read as a comment; quote the value";
  return null;
}

function unquote(value) {
  const d = value.match(/^"(.*)"$/);
  if (d) return d[1].replace(/\\(.)/g, "$1");
  const s = value.match(/^'(.*)'$/);
  return s ? s[1].replace(/''/g, "'") : value;
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

const CLAUDE_VARIABLE = /\$\{CLAUDE_(?:PLUGIN_ROOT|SKILL_DIR)\}/g;
const CLAUDE_NOTE = /^\s*(?:(?:[-*>]|\d+\.)\s*)*In Claude Code,/;

/**
 * Claude Code variables outside a Claude-layer note: a line whose text, after
 * optional list, blockquote or bold markers, starts with `In Claude Code,`.
 * Every line counts, code fences included.
 */
function checkClaudeVariables(issues, file, scanned) {
  for (const l of scanned) {
    if (CLAUDE_NOTE.test(l.text)) continue;
    for (const m of l.text.matchAll(CLAUDE_VARIABLE)) {
      issue(
        issues,
        file,
        l.n,
        "claude-variable",
        `${m[0]} only expands in Claude Code: use a relative path, or move it to an "In Claude Code," line`
      );
    }
  }
}

const PATH_TOKEN = /(?<![\w./-])(\.\.?\/|<plugin-root>\/)([^\s"'`)]*)/g;
const OPTION_BEFORE = /(?:^|[\s`"'(])--?[A-Za-z][\w-]*[\s=]+$/;

/**
 * Relative paths (`./`, `../`, `<plugin-root>/`) that do not resolve, in
 * prose, inline code and fences. A `./` or `../` path resolves against the
 * directory of the file, a `<plugin-root>/` path against the plugin
 * directory. A `#anchor` is stripped; a token holding a placeholder or glob
 * (`<`, `*`, `{`, `$`) after the prefix is skipped, and `.../` never matches.
 * The value of a command option (`--repo-dir ../lib`, `rm -rf ./data`) names
 * a file of the user's repository and is skipped too. Only plugin files are
 * checked: repository skills run from the repository root. With `relative`
 * off (the plugin README, whose `./` and `../` paths illustrate the user's
 * repository or a skill's view), only `<plugin-root>/` paths are checked.
 * Returns the number of paths checked.
 */
function checkPaths(issues, root, file, scanned, pluginDir, relative = true) {
  let checked = 0;
  if (!pluginDir) return checked;
  for (const l of scanned) {
    for (const m of l.text.matchAll(PATH_TOKEN)) {
      const [, prefix, rest] = m;
      if (/[<*{$]/.test(rest)) continue;
      if (OPTION_BEFORE.test(l.text.slice(0, m.index))) continue;
      const target = rest.split("#")[0].replace(/[.,;:]+$/, "");
      let base;
      if (prefix === "<plugin-root>/") {
        base = join(root, pluginDir);
      } else {
        if (!relative) continue;
        base = resolve(dirname(join(root, file)), prefix);
      }
      checked++;
      if (!existsSync(resolve(base, target))) {
        issue(issues, file, l.n, "path", `path not found: ${prefix}${target}`);
      }
    }
  }
  return checked;
}

/** The plugin directory (`plugins/<name>`) that holds a file, or null. */
function pluginDirOf(file) {
  const parts = file.split(/[\\/]/);
  return parts[0] === "plugins" && parts.length > 2
    ? `plugins/${parts[1]}`
    : null;
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
  const name = fm.fields.name?.value ?? "";
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
  if (!d || !d.value.trim()) {
    return issue(issues, file, 1, "frontmatter", "missing `description`");
  }
  const len = d.value.length;
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

/**
 * The raw `policy.allow_implicit_invocation` of an agents/openai.yaml, read
 * from a nested block or a flow mapping (`policy: {...}`), or undefined.
 */
export function readImplicitPolicy(text) {
  const policy = parseYaml(text.split(/\r?\n/)).fields.policy;
  if (!policy) return undefined;
  const entries = policy.children ?? flowMapping(policy.raw) ?? {};
  return entries.allow_implicit_invocation?.raw;
}

/**
 * The Codex metadata beside a skill (agents/openai.yaml) parses strictly and
 * its invocation policy matches `disable-model-invocation`: a user-invoked
 * skill sets `allow_implicit_invocation: false`, and a model-invoked skill
 * never does, or Codex hides it.
 */
function checkCodexMetadata(issues, root, file, fm) {
  const meta = join(dirname(file), "agents", "openai.yaml")
    .split(sep)
    .join("/");
  const userInvoked = fm.fields["disable-model-invocation"]?.value === "true";
  if (!existsSync(join(root, meta))) {
    if (userInvoked) {
      issue(
        issues,
        file,
        fm.fields["disable-model-invocation"].line,
        "codex",
        "user-invoked skill without agents/openai.yaml; Codex will invoke it implicitly",
        "warn"
      );
    }
    return;
  }
  const text = readFileSync(join(root, meta), "utf8");
  checkAscii(issues, meta, text, false);
  for (const e of parseYaml(text.split(/\r?\n/)).errors) {
    issue(issues, meta, e.line, "yaml", e.message);
  }
  const policy = readImplicitPolicy(text);
  if (policy !== undefined && policy !== "true" && policy !== "false") {
    issue(
      issues,
      meta,
      1,
      "codex",
      `policy.allow_implicit_invocation must be true or false, not ${policy}`
    );
    return;
  }
  if (userInvoked && policy !== "false") {
    issue(
      issues,
      meta,
      1,
      "codex",
      "the skill sets disable-model-invocation: true; set policy.allow_implicit_invocation: false"
    );
  }
  if (!userInvoked && policy === "false") {
    issue(
      issues,
      meta,
      1,
      "codex",
      "policy.allow_implicit_invocation: false hides a model-invoked skill from Codex"
    );
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
  for (const e of fm.yamlErrors) issue(issues, file, e.line, "yaml", e.message);
  const prefix = pluginSkill ? `${parts[1].split("-")[0]}-` : null;
  checkName(issues, file, fm, basename(dirname(file)), prefix);
  checkDescription(issues, file, fm);
  checkCodexMetadata(issues, root, file, fm);
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
  checkClaudeVariables(issues, file, scanned);
  const paths = checkPaths(issues, root, file, scanned, pluginDirOf(file));
  if (paths && !text.includes("relative to this skill's directory")) {
    issue(
      issues,
      file,
      1,
      "paths-note",
      "the skill uses relative paths: state that they are relative to this skill's directory"
    );
  }
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
  for (const e of fm.yamlErrors) issue(issues, file, e.line, "yaml", e.message);
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
  checkClaudeVariables(issues, file, scanned);
  checkPaths(issues, root, file, scanned, pluginDirOf(file));
  checkAscii(issues, file, text, true);
  return issues;
}

/** A skill or shared reference file: links, Claude variables and paths. */
export function validateReference(root, file) {
  const issues = [];
  const scanned = scanLines(readFileSync(join(root, file), "utf8"));
  checkLinks(issues, root, file, scanned);
  checkClaudeVariables(issues, file, scanned);
  checkPaths(issues, root, file, scanned, pluginDirOf(file));
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
  checkClaudeVariables(issues, file, scanned);
  checkPaths(issues, root, file, scanned, plugin.dir, false);
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

// --------------------------------------------------------------- workflows

/** Agent types built into Claude Code that a workflow may name bare. */
export const BUILTIN_AGENT_TYPES = [
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup"
];

/**
 * Blank the comments and string contents of a JavaScript source, keeping
 * every offset and newline, so code patterns can be matched safely. Quote
 * characters stay; template literal text is blanked but its `${...}`
 * expressions are kept as code.
 */
export function maskJs(text) {
  const out = text.split("");
  const blank = (i) => {
    if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
  };
  // Stack of open contexts: "code" (inside ${...}, with its brace depth) or
  // "template".
  const stack = [];
  let depth = 0;
  let i = 0;
  const inTemplate = () => stack[stack.length - 1]?.kind === "template";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inTemplate()) {
      if (ch === "\\") {
        blank(i);
        blank(i + 1);
        i += 2;
      } else if (ch === "`") {
        stack.pop();
        i++;
      } else if (ch === "$" && next === "{") {
        stack.push({ kind: "code", depth });
        depth = 0;
        i += 2;
      } else {
        blank(i);
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") blank(i++);
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      while (i < stop) blank(i++);
    } else if (ch === '"' || ch === "'") {
      i++;
      while (i < text.length && text[i] !== ch && text[i] !== "\n") {
        if (text[i] === "\\") blank(i++);
        blank(i++);
      }
      i++;
    } else if (ch === "`") {
      stack.push({ kind: "template" });
      i++;
    } else if (ch === "{") {
      depth++;
      i++;
    } else if (ch === "}") {
      if (depth === 0 && stack[stack.length - 1]?.kind === "code") {
        depth = stack.pop().depth;
      } else depth--;
      i++;
    } else i++;
  }
  return out.join("");
}

function lineAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

/** Read the string literal starting at `offset` of the original source. */
function stringAt(text, offset) {
  const m = text.slice(offset).match(/^(["'])((?:\\.|(?!\1).)*)\1/);
  return m ? m[2] : null;
}

/**
 * Find the `export const meta = {...}` literal: it must be the first
 * statement and a pure literal (strings, numbers, booleans, null, arrays and
 * objects with plain keys). Returns { value, line } or { error, line }.
 */
export function readWorkflowMeta(text) {
  const masked = maskJs(text);
  const start = masked.search(/\S/);
  const head = masked.slice(start).match(/^export\s+const\s+meta\s*=\s*\{/);
  if (start < 0 || !head) {
    return {
      error: "the script must begin with `export const meta = {...}`",
      line: 1
    };
  }
  const open = start + head[0].length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    if (masked[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  const line = lineAt(text, start);
  if (close < 0) return { error: "meta literal is not closed", line };
  const literal = text.slice(open, close + 1);
  const tokens = [];
  const re =
    /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`[^`]*`|-?\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|[{}[\]:,]|\S+/gy;
  for (const m of literal.matchAll(re)) {
    if (/^(\s|\/\/|\/\*)/.test(m[0])) continue;
    tokens.push({ text: m[0], offset: open + m.index });
  }
  for (const [k, t] of tokens.entries()) {
    const prev = tokens[k - 1]?.text;
    const next = tokens[k + 1]?.text;
    let ok = /^["'\d-]|^[{}[\]:,]$/.test(t.text);
    if (t.text.startsWith("`")) ok = !t.text.includes("${");
    if (/^[A-Za-z_$]/.test(t.text)) {
      ok =
        ["true", "false", "null"].includes(t.text) ||
        (next === ":" && (prev === "{" || prev === ","));
    }
    if (!ok) {
      return {
        error: `meta must be a pure literal; found \`${t.text}\``,
        line: lineAt(text, t.offset)
      };
    }
  }
  try {
    return {
      value: runInNewContext(`(${literal})`, Object.create(null)),
      line
    };
  } catch (e) {
    return { error: `meta does not parse: ${e.message}`, line };
  }
}

export function validateWorkflow(root, file, plugin) {
  const issues = [];
  const text = readFileSync(join(root, file), "utf8");
  checkAscii(issues, file, text, false);
  const meta = readWorkflowMeta(text);
  if (meta.error) {
    issue(issues, file, meta.line, "workflow", meta.error);
  } else {
    const { value } = meta;
    for (const key of ["name", "description"]) {
      if (typeof value[key] !== "string" || !value[key].trim()) {
        issue(issues, file, meta.line, "workflow", `meta needs a \`${key}\``);
      }
    }
    const expected = basename(file, ".js");
    if (typeof value.name === "string" && value.name !== expected) {
      issue(
        issues,
        file,
        meta.line,
        "workflow",
        `meta name "${value.name}" does not match "${expected}"`
      );
    }
    const prefix = `${plugin.name.split("-")[0]}-`;
    if (typeof value.name === "string" && !value.name.startsWith(prefix)) {
      issue(
        issues,
        file,
        meta.line,
        "workflow",
        `meta name lacks the "${prefix}" prefix`
      );
    }
    const titles = Array.isArray(value.phases)
      ? value.phases.map((p) => p?.title)
      : [];
    const masked = maskJs(text);
    for (const m of masked.matchAll(/\bphase\(\s*(["'])/g)) {
      const offset = m.index + m[0].length - 1;
      const title = stringAt(text, offset);
      if (title !== null && !titles.includes(title)) {
        issue(
          issues,
          file,
          lineAt(text, offset),
          "workflow",
          `phase "${title}" is not in meta.phases`
        );
      }
    }
  }

  const masked = maskJs(text);
  const forbidden = [
    [/\bimport\s*\(/g, "dynamic import() is not available"],
    [/\brequire\s*\(/g, "require() is not available"],
    [/\bDate\s*\.\s*now\b/g, "Date.now() breaks resume; pass times in args"],
    [/\bMath\s*\.\s*random\b/g, "Math.random() breaks resume"],
    [/\bnew\s+Date\s*(\(\s*\))?(?!\s*\()/g, "new Date() breaks resume"]
  ];
  for (const [re, message] of forbidden) {
    for (const m of masked.matchAll(re)) {
      issue(issues, file, lineAt(text, m.index), "workflow", message);
    }
  }
  if (/^\s*import\s/m.test(masked)) {
    issue(issues, file, 1, "workflow", "import statements are not available");
  }

  for (const m of text.matchAll(CLAUDE_VARIABLE)) {
    issue(
      issues,
      file,
      lineAt(text, m.index),
      "claude-variable",
      `${m[0]} only expands in Claude Code: pass the plugin root in args`
    );
  }

  const agents = new Set(plugin.agents.map((a) => basename(a, ".md")));
  for (const m of masked.matchAll(/\bagentType\s*:\s*(["'])/g)) {
    const offset = m.index + m[0].length - 1;
    const type = stringAt(text, offset);
    if (type === null || BUILTIN_AGENT_TYPES.includes(type)) continue;
    const [ns, name] = type.includes(":") ? type.split(":") : [null, type];
    let message = null;
    if (ns === null) {
      message = agents.has(type)
        ? `agentType needs the plugin namespace: "${plugin.name}:${type}"`
        : `unknown agentType "${type}"`;
    } else if (ns !== plugin.name || !agents.has(name)) {
      message = `agentType "${type}" names no agent in ${plugin.dir}/agents/`;
    }
    if (message) issue(issues, file, lineAt(text, offset), "workflow", message);
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
            workflows: files.filter(
              (f) =>
                f.startsWith(`${dir}/workflows/`) &&
                f.endsWith(".js") &&
                f.split("/").length === dir.split("/").length + 2
            ),
            references: files.filter(
              (f) =>
                f.endsWith(".md") &&
                !TEMPLATE_FILES.has(f) &&
                (/^plugins\/[^/]+\/references\/[^/]+\.md$/.test(f) ||
                  (f.startsWith(`${dir}/skills/`) &&
                    f.includes("/references/")))
            ),
            readme: existsSync(join(root, dir, "README.md"))
              ? `${dir}/README.md`
              : null
          };
        })
    : [];
  const repoFiles = walk(root, ".claude/skills");
  const repoSkills = repoFiles.filter((f) => f.endsWith("/SKILL.md"));
  const repoReferences = repoFiles.filter(
    (f) => f.endsWith(".md") && f.includes("/references/")
  );
  return { plugins, repoSkills, repoReferences };
}

export function validate(root) {
  const templates = Object.fromEntries(
    Object.entries(TEMPLATES).map(([k, path]) => [
      k,
      parseTemplate(readFileSync(join(root, path), "utf8"))
    ])
  );
  const { plugins, repoSkills, repoReferences } = discover(root);
  const issues = [];
  const counts = {
    skills: repoSkills.length,
    agents: 0,
    workflows: 0,
    readmes: 0,
    references: repoReferences.length
  };
  for (const f of repoSkills)
    issues.push(...validateSkill(root, f, templates.skill));
  for (const f of repoReferences) issues.push(...validateReference(root, f));
  for (const p of plugins) {
    counts.skills += p.skills.length;
    counts.agents += p.agents.length;
    for (const f of p.skills)
      issues.push(...validateSkill(root, f, templates.skill));
    for (const f of p.agents)
      issues.push(...validateAgent(root, f, templates.agent));
    counts.references += p.references.length;
    for (const f of p.references) issues.push(...validateReference(root, f));
    counts.workflows += p.workflows.length;
    for (const f of p.workflows) issues.push(...validateWorkflow(root, f, p));
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
      `Checked ${counts.skills} skills, ${counts.agents} agents, ${counts.workflows} workflows, ${counts.readmes} READMEs and ${counts.references} references: ${errors} errors, ${issues.length - errors} warnings\n`
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
