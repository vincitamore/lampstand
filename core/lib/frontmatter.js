// @ts-check
// Frontmatter is a leading block of a Markdown file, opened by a first line of exactly `---` and closed by the next
// line of exactly `---`, holding a YAML mapping in lampstand's strict subset. A file whose first line is not `---`
// has no frontmatter; an opened block that never closes is an error, since guessing where it ends would turn body
// text into data.
import { fail } from "./errors.js";
import { normalizeLf, readText, stripBom } from "./io.js";
import { parseYamlMapping } from "./parse/yaml.js";

/** @typedef {import("./parse/yaml.js").YamlMap} Frontmatter */
/** @typedef {{ frontmatter: Frontmatter | null, body: string, bodyLine: number }} ParsedMarkdown */

const FENCE = /^---[ \t]*$/;

/**
 * Splits Markdown text into its frontmatter mapping (or null) and the body after the closing fence. `bodyLine` is
 * the 1-based file line where the body starts.
 * @param {string} text
 * @param {string} path  named in every error
 * @returns {ParsedMarkdown}
 */
export function parseFrontmatter(text, path) {
  const source = normalizeLf(stripBom(text));
  const firstBreak = source.indexOf("\n");
  const firstLine = firstBreak < 0 ? source : source.slice(0, firstBreak);
  if (!FENCE.test(firstLine)) return { frontmatter: null, body: source, bodyLine: 1 };
  if (firstBreak < 0) throw fail("E_PARSE_FRONTMATTER", "frontmatter opened by --- is never closed", { path, line: 1 });

  let start = firstBreak + 1;
  for (let line = 2; ; line++) {
    const end = source.indexOf("\n", start);
    const current = end < 0 ? source.slice(start) : source.slice(start, end);
    if (FENCE.test(current)) {
      const yaml = source.slice(firstBreak + 1, start);
      return {
        frontmatter: parseYamlMapping(yaml, path, 2),
        body: end < 0 ? "" : source.slice(end + 1),
        bodyLine: line + 1,
      };
    }
    if (end < 0) throw fail("E_PARSE_FRONTMATTER", "frontmatter opened by --- is never closed", { path, line: 1 });
    start = end + 1;
  }
}

/**
 * Reads a Markdown file and parses its frontmatter.
 * @param {string} path
 * @returns {ParsedMarkdown}
 */
export function readFrontmatter(path) {
  return parseFrontmatter(readText(path), path);
}
