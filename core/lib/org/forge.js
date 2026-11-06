// @ts-check
// Forge sessions: one manifest per multi-agent pipeline under forge/sessions/, with an append-only execution log.
// The log's timestamps are written by this module from its own clock and never taken from the caller, so the log
// orders what happened even when agents disagree about the time or copy each other's lines.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { fail, isLampstandError } from "../errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import { atomicWrite, readText } from "../io.js";
import { fillTemplate, fullPath } from "./items.js";
import { renderItem, slugify, localDate } from "./markdown.js";

export const FORGE_DIR = "forge/sessions";
export const LOG_HEADING = "## Execution log";

/** A log line: `- <UTC timestamp> | <entry>`. */
const LOG_LINE = /^- ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) \| (.*)$/;
const STAGE = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;

/**
 * Timestamp shapes an entry may not carry: a date with a time of day anywhere, or a leading date, time or bracketed
 * stamp. A bare date inside the text (a deadline, a version) is content and passes.
 */
const OWN_TIMESTAMP = [
  /[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{1,2}:[0-9]{2}/,
  /^\s*\[?\s*[0-9]{4}-[0-9]{2}-[0-9]{2}\b/,
  /^\s*\[?\s*[0-9]{1,2}:[0-9]{2}\b/,
  /^\s*\[[^\]]*[0-9]{1,2}:[0-9]{2}[^\]]*\]/,
];

/** UTC to the second, the form every log line carries. @param {Date} [now] */
export function logTimestamp(now = new Date()) {
  return now.toISOString().replace(/\.[0-9]{3}Z$/, "Z");
}

/**
 * Refuses an entry the log cannot take as given: empty, more than one line, or carrying its own timestamp.
 * @param {string} entry
 */
export function checkEntry(entry) {
  const text = entry.trim();
  if (text === "") throw fail("E_USAGE", "a log entry is one non-empty line");
  if (/[\r\n]/.test(text)) throw fail("E_USAGE", "a log entry is one line");
  if (OWN_TIMESTAMP.some((pattern) => pattern.test(text))) {
    throw fail("E_USAGE", "the entry carries its own timestamp; forge log writes the time itself, so give only the entry");
  }
  return text;
}

/**
 * @param {string} root
 * @param {{ title: string, stages: string[], body?: string, now?: Date }} input
 * @returns {string} the manifest's house-relative path
 */
export function newSession(root, input) {
  const title = input.title.trim();
  if (title === "" || /[\r\n]/.test(title)) throw fail("E_USAGE", "a title is one non-empty line");
  for (const stage of input.stages) {
    if (!STAGE.test(stage)) throw fail("E_USAGE", `stage ${JSON.stringify(stage)} must be letters, digits, spaces, dots, underscores or hyphens`);
  }
  const now = input.now ?? new Date();
  const prefix = logTimestamp(now).slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const base = `${prefix}-${slugify(title, 48) || "session"}`;
  let stem = base;
  for (let n = 2; existsSync(fullPath(root, `${FORGE_DIR}/${stem}.md`)); n++) stem = `${base}-${n}`;
  const rel = `${FORGE_DIR}/${stem}.md`;
  const pipeline = input.stages.length === 0 ? "No stages declared.\n" : `${input.stages.map((stage) => `- [ ] ${stage}`).join("\n")}\n`;
  const body = fillTemplate("forge", {
    title,
    body: input.body === undefined || input.body.trim() === "" ? "" : `\n${input.body.trim()}\n`,
    pipeline,
  });
  mkdirSync(fullPath(root, FORGE_DIR), { recursive: true });
  atomicWrite(fullPath(root, rel), renderItem({ kind: "forge", title, status: "open", created: localDate(now), stages: input.stages }, body));
  return rel;
}

/**
 * The session `ref` names: a stem, a file name or a house-relative path under forge/sessions/.
 * @param {string} root
 * @param {string} ref
 */
export function findSession(root, ref) {
  const name = ref.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^forge\/sessions\//, "").replace(/\.md$/i, "");
  if (name === "" || name.includes("/")) throw fail("E_USAGE", `${JSON.stringify(ref)} does not name a session in ${FORGE_DIR}/`);
  const rel = `${FORGE_DIR}/${name}.md`;
  if (!existsSync(fullPath(root, rel))) throw fail("E_USAGE", `no forge session ${JSON.stringify(ref)} in ${FORGE_DIR}/`);
  return rel;
}

/**
 * The index of the line that ends the execution log section: the next heading after it (outside code fences), or the
 * end of the text.
 * @param {string[]} lines
 * @param {number} heading
 */
function sectionEnd(lines, heading) {
  let fence = false;
  for (let k = heading + 1; k < lines.length; k++) {
    if (/^ {0,3}(```|~~~)/.test(lines[k])) fence = !fence;
    else if (!fence && /^ {0,3}#{1,6}(?:[ \t]|$)/.test(lines[k])) return k;
  }
  return lines.length;
}

/**
 * Appends `- <now> | <entry>` as the last line of the execution log section, before any later heading.
 * @param {string} root
 * @param {string} rel
 * @param {string} entry
 * @param {Date} [now]
 */
export function appendLog(root, rel, entry, now = new Date()) {
  const text = checkEntry(entry);
  const full = fullPath(root, rel);
  const source = readText(full);
  const lines = source.split("\n");
  const heading = lines.findIndex((line) => line.trimEnd() === LOG_HEADING);
  if (heading < 0) throw fail("E_SCHEMA", `the manifest has no "${LOG_HEADING}" heading to append to`, { path: rel });
  const end = sectionEnd(lines, heading);
  let last = end - 1;
  while (last > heading && lines[last].trim() === "") last--;
  const line = `- ${logTimestamp(now)} | ${text}`;
  /** @type {string[]} */
  const insert = last === heading ? ["", line] : [line];
  if (end === lines.length) {
    // The log is the last section: drop its trailing blank lines so the file ends with exactly one newline.
    lines.splice(last + 1, lines.length, ...insert, "");
  } else {
    // Keep one blank line between the log and the heading that follows it.
    if (last + 1 === end) insert.push("");
    lines.splice(last + 1, 0, ...insert);
  }
  const out = lines.join("\n");
  atomicWrite(full, out);
  return line;
}

/**
 * @typedef {{
 *   path: string,
 *   title: string,
 *   status: string,
 *   created: string,
 *   stages: string[],
 *   entries: { at: string, entry: string }[],
 *   error: string | null,
 * }} SessionSummary
 */

/** @param {string} root @param {string} rel @returns {SessionSummary} */
export function readSession(root, rel) {
  const text = readText(fullPath(root, rel));
  /** @type {SessionSummary} */
  const summary = { path: rel, title: "", status: "", created: "", stages: [], entries: [], error: null };
  try {
    const fm = parseFrontmatter(text, rel).frontmatter ?? {};
    summary.title = typeof fm.title === "string" ? fm.title : "";
    summary.status = typeof fm.status === "string" ? fm.status : "";
    summary.created = typeof fm.created === "string" ? fm.created : "";
    summary.stages = Array.isArray(fm.stages) ? fm.stages.map(String) : [];
  } catch (error) {
    if (!isLampstandError(error)) throw error;
    summary.error = error.message;
  }
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => line.trimEnd() === LOG_HEADING);
  if (heading >= 0) {
    for (const line of lines.slice(heading + 1, sectionEnd(lines, heading))) {
      const match = LOG_LINE.exec(line);
      if (match) summary.entries.push({ at: match[1], entry: match[2] });
    }
  }
  return summary;
}

/** Every session manifest, oldest first (names start with their UTC creation minute). @param {string} root */
export function listSessions(root) {
  const dir = fullPath(root, FORGE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `${FORGE_DIR}/${entry.name}`)
    .sort();
}
