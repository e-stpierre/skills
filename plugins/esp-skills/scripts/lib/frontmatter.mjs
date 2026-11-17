// Flat YAML frontmatter (`key: scalar` lines) of a markdown document.

/**
 * Parse flat YAML frontmatter from a markdown document.
 * Returns null when the document has no frontmatter.
 */
export function parseFrontmatter(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/.exec(text);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`Unsupported frontmatter line: ${line}`);
    data[kv[1]] = parseScalar(kv[2].trim());
  }
  return data;
}

function parseScalar(raw) {
  if (raw === "" || raw === "null" || raw === "~") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^".*"$/.test(raw)) return JSON.parse(raw);
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}
