// @ts-check
// Text-level helpers for org files: slugs, editing one top-level frontmatter key in place (so the rest of a file the
// user wrote keeps its exact bytes), and finding links outside code: [[wikilinks]] and inline Markdown links.
import { fail } from "../errors.js";
import { parseFrontmatter } from "../frontmatter.js";

/** @typedef {import("../parse/yaml.js").YamlValue} YamlValue */
/**
 * @typedef {{
 *   syntax: "wiki" | "markdown",
 *   index: number,
 *   length: number,
 *   line: number,
 *   target: string,
 *   rest: string,
 *   angle: boolean,
 * }} Link
 *   `index` and `length` span the target as written and its `rest`: for a wikilink the text between `[[` and `]]`,
 *   whose `rest` is the `#heading` and `|alias` part; for a Markdown link the destination inside `(...)` (inside
 *   `<...>` when `angle`) without its title, whose `rest` is the `?query` and `#fragment` part. `target` is the path
 *   meant: for a Markdown link percent-decoded.
 */

/**
 * A filename stem from free text: lowercase ASCII letters, digits and single hyphens, at most `max` characters.
 * @param {string} text
 * @param {number} [max]
 */
export function slugify(text, max = 60) {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/, "");
}

/**
 * A frontmatter value line in the strict subset: strings double-quoted, so nothing is re-read as another type.
 * @param {string} key
 * @param {string} value
 */
function fieldLine(key, value) {
  return `${key}: ${JSON.stringify(value)}`;
}

/**
 * The frontmatter block's line range: the closing fence's line index (0-based), or -1 when the text has none.
 * @param {string[]} lines
 */
function closingFence(lines) {
  if (!/^---[ \t]*$/.test(lines[0] ?? "")) return -1;
  for (let k = 1; k < lines.length; k++) if (/^---[ \t]*$/.test(lines[k])) return k;
  return -1;
}

/**
 * The line span [start, end) of top-level `key` inside the frontmatter, including indented continuation lines and
 * the blank lines between them (a block scalar may hold empty lines).
 * @param {string[]} lines
 * @param {number} close
 * @param {string} key
 */
function keySpan(lines, close, key) {
  const head = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:(?:[ \\t]|$)`);
  for (let k = 1; k < close; k++) {
    if (!head.test(lines[k])) continue;
    let end = k + 1;
    for (let next = end; next < close; next++) {
      if (lines[next].trim() === "") continue;
      if (!/^(?:[ \t]|-(?:[ \t]|$))/.test(lines[next])) break;
      end = next + 1;
    }
    return { start: k, end };
  }
  return null;
}

/**
 * Sets or removes top-level frontmatter keys, leaving every other line as it was. A value of null removes the key;
 * a new key goes just before the closing fence. The result is re-parsed so an edit can never leave a file that the
 * frontmatter parser refuses.
 * @param {string} text
 * @param {Record<string, string | null>} changes
 * @param {string} path  named in errors
 */
export function editFrontmatter(text, changes, path) {
  const lines = text.split("\n");
  const close = closingFence(lines);
  if (close < 0) throw fail("E_PARSE_FRONTMATTER", "the file has no frontmatter block to edit", { path, line: 1 });
  let fence = close;
  for (const [key, value] of Object.entries(changes)) {
    const span = keySpan(lines, fence, key);
    const replacement = value === null ? [] : [fieldLine(key, value)];
    if (span) {
      lines.splice(span.start, span.end - span.start, ...replacement);
      fence += replacement.length - (span.end - span.start);
    } else if (value !== null) {
      lines.splice(fence, 0, ...replacement);
      fence += 1;
    }
  }
  const out = lines.join("\n");
  parseFrontmatter(out, path);
  return out;
}

/**
 * Renders a new file: frontmatter (strings double-quoted, arrays as one-line flow sequences) then the body.
 * @param {Record<string, string | string[]>} fields
 * @param {string} body
 */
export function renderItem(fields, body) {
  const lines = Object.entries(fields).map(([key, value]) =>
    Array.isArray(value) ? `${key}: [${value.map((item) => JSON.stringify(item)).join(", ")}]` : fieldLine(key, value),
  );
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/**
 * The text with fenced code blocks and inline code spans blanked to spaces (newlines kept), so offsets still map onto
 * the original: a `[[x]]` inside code is an example, not a link.
 * @param {string} text
 */
export function maskCode(text) {
  const lines = text.split("\n");
  /** @type {string | null} */
  let fence = null;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && line.trim() === opener[1]) fence = null;
      lines[k] = " ".repeat(line.length);
      continue;
    }
    if (opener) {
      fence = opener[1];
      lines[k] = " ".repeat(line.length);
      continue;
    }
    lines[k] = line.replace(/(`+)(?:(?!\1)[^\n])*?\1/g, (span) => " ".repeat(span.length));
  }
  return lines.join("\n");
}

const WIKILINK = /\[\[([^\[\]\n|#]*)((?:#[^\[\]\n|]*)?(?:\|[^\[\]\n]*)?)\]\]/g;
// `[text](dest "title")` and `![alt](dest)`: the text may hold one level of brackets; the destination is `<...>` or a
// run without blanks whose parentheses are balanced one level deep, as CommonMark reads it.
const MARKDOWN_LINK =
  /!?\[(?:[^\[\]\n]|\[[^\[\]\n]*\])*\]\([ \t]*(?:<([^<>\n]*)>|((?:[^\s()<>]|\([^\s()]*\))+))?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/dg;

/**
 * Every [[wikilink]] outside code, in order.
 * @param {string} text
 * @returns {Link[]}
 */
export function findWikilinks(text) {
  const masked = maskCode(text);
  const lineAt = lineCounter(masked);
  return [...masked.matchAll(WIKILINK)].map((match) => {
    const at = /** @type {number} */ (match.index);
    return { syntax: "wiki", index: at + 2, length: match[0].length - 4, line: lineAt(at), target: match[1], rest: match[2], angle: false };
  });
}

/**
 * Every inline Markdown link and image outside code that has a destination, in order.
 * @param {string} text
 * @returns {Link[]}
 */
export function findMarkdownLinks(text) {
  const masked = maskCode(text);
  const lineAt = lineCounter(masked);
  /** @type {Link[]} */
  const out = [];
  for (const match of masked.matchAll(MARKDOWN_LINK)) {
    const group = match[1] !== undefined ? 1 : 2;
    const span = match.indices?.[group];
    if (!span) continue;
    const written = text.slice(span[0], span[1]);
    const cut = written.search(/[?#]/);
    const path = cut < 0 ? written : written.slice(0, cut);
    out.push({
      syntax: "markdown",
      index: span[0],
      length: written.length,
      line: lineAt(/** @type {number} */ (match.index)),
      target: percentDecode(path),
      rest: cut < 0 ? "" : written.slice(cut),
      angle: group === 1,
    });
  }
  return out;
}

/**
 * Every link outside code, wikilinks and Markdown links together, in order.
 * @param {string} text
 */
export function findLinks(text) {
  return [...findWikilinks(text), ...findMarkdownLinks(text)].sort((a, b) => a.index - b.index);
}

/** A function from an offset in `text` to its 1-based line; offsets must be asked in increasing order. @param {string} text */
function lineCounter(text) {
  let line = 1;
  let counted = 0;
  return (/** @type {number} */ at) => {
    for (; counted < at; counted++) if (text.charCodeAt(counted) === 10) line++;
    return line;
  };
}

/** A Markdown destination path with its percent-escapes read; left as written when they do not decode. @param {string} path */
function percentDecode(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Replaces link targets, right to left so earlier offsets stay valid. A Markdown destination outside `<...>` is
 * written with the characters that would end or break it percent-encoded.
 * @param {string} text
 * @param {{ link: Link, target: string }[]} edits
 */
export function rewriteLinks(text, edits) {
  let out = text;
  for (const { link, target } of [...edits].sort((a, b) => b.link.index - a.link.index)) {
    const written = link.syntax === "markdown" && !link.angle ? target.replace(/[%\s()<>#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`) : target;
    out = `${out.slice(0, link.index)}${written}${link.rest}${out.slice(link.index + link.length)}`;
  }
  return out;
}

/** The line (1-based) on which top-level frontmatter `key` sits, or 1. @param {string} text @param {string} key */
export function keyLine(text, key) {
  const lines = text.split("\n");
  const close = closingFence(lines);
  const span = close < 0 ? null : keySpan(lines, close, key);
  return span ? span.start + 1 : 1;
}

/** Today's date in UTC as YYYY-MM-DD. @param {Date} [now] */
export function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** True for a YYYY-MM-DD string naming a real calendar date. @param {string} text */
export function isDate(text) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}
