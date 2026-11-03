// @ts-check
// Parsers for the constitution's authored files: principle files, provisions, reflexes, the reflex index preface,
// voice, purpose and the ask-first lines. Each is a pure function of one file's text, so the compiler, the curation
// rules, adopt and propose all read a file the same way. Structure a projection cannot be built without (a principle
// with no thesis or no facets, a provision with no title) is refused with the path and line; curation fields whose
// absence is a finding (occasion, failure mode, falsification trigger, revision step) are parsed as optional and left
// to the curation rules, so the refusal names the rule rather than a schema key.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { validate } from "../config.js";
import { fail } from "../errors.js";
import { parseFrontmatter } from "../frontmatter.js";

/** @typedef {import("../config.js").Schema & { "x-proposal-required"?: string[] }} KindSchema */
/** @typedef {import("../frontmatter.js").Frontmatter} Frontmatter */
/** @typedef {"principle" | "provision" | "reflex"} Kind */
/** @typedef {"adopted" | "proposal"} Standing */

/** @param {Kind} kind @returns {KindSchema} */
function loadSchema(kind) {
  return JSON.parse(readFileSync(new URL(`../../../schema/constitution/${kind}.schema.json`, import.meta.url), "utf8"));
}

export const SCHEMAS = Object.freeze({
  principle: loadSchema("principle"),
  provision: loadSchema("provision"),
  reflex: loadSchema("reflex"),
});

export const KINDS = /** @type {readonly Kind[]} */ (Object.freeze(["principle", "provision", "reflex"]));

/** The agent hosts a reflex may be scoped to with `tool:<host>`; projections that carry reflexes exist per host. */
export const HOSTS = Object.freeze(["hermes", "omp"]);

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The slug of a constitution file: its name without `.md`. Slugs name items on the command line (`--ids
 * principle/<slug>`), so they are restricted to characters that need no quoting.
 * @param {string} path
 */
export function slugOf(path) {
  const slug = basename(path).replace(/\.md$/, "");
  if (!SLUG.test(slug)) {
    throw fail("E_SCHEMA", `file name must be lowercase letters, digits and hyphens before .md, found ${JSON.stringify(basename(path))}`, { path });
  }
  return slug;
}

/**
 * Validates frontmatter for a kind. An adopted file must carry the schema's `required` keys; a proposal carries
 * `x-proposal-required` instead, since it has not been adopted yet.
 * @param {Kind} kind
 * @param {Frontmatter | null} frontmatter
 * @param {Standing} standing
 * @param {string} path
 * @returns {Frontmatter}
 */
export function checkFrontmatter(kind, frontmatter, standing, path) {
  if (frontmatter === null) throw fail("E_SCHEMA", `a ${kind} file must open with a frontmatter block`, { path, line: 1 });
  const schema = SCHEMAS[kind];
  validate(standing === "adopted" ? schema : { ...schema, required: schema["x-proposal-required"] ?? [] }, frontmatter, path);
  return frontmatter;
}

/** @param {Frontmatter} frontmatter @param {string} key */
function optionalString(frontmatter, key) {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @typedef {{ name: string, text: string }} Facet
 * @typedef {{ label: "Vice" | "Failure mode", text: string, summary: string }} FailureMode
 * @typedef {{
 *   path: string, line: number, mark: string, name: string, thesis: string, facets: Facet[],
 *   failureMode: FailureMode | null,
 * }} Principle
 * @typedef {{ path: string, line: number, title: string, text: string }} Section
 * @typedef {{
 *   path: string, slug: string, frontmatter: Frontmatter, body: string, preface: string,
 *   principles: Principle[], sections: Section[],
 * }} PrincipleFile
 */

const HEADING = /^(#{1,3})[ \t]+(.+?)[ \t]*$/;
const PRINCIPLE_HEADING = /^(\S(?:.*?\S)?) : (\S(?:.*\S)?)$/;
const FACET = /^[-*] \*\*(.+?)\*\*:[ \t]+(\S.*)$/;
const FAILURE_LABEL = /^\*(Vice|Failure mode):\*[ \t]*/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * The 0-based indexes of lines outside fenced code blocks, so a heading or bullet inside a code sample is text.
 * @param {string[]} lines
 * @returns {boolean[]}
 */
function proseMask(lines) {
  const mask = [];
  /** @type {string | null} */
  let fence = null;
  for (const line of lines) {
    const open = FENCE.exec(line);
    if (open) {
      if (fence === null) fence = open[1];
      else if (open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      mask.push(false);
      continue;
    }
    mask.push(fence === null);
  }
  return mask;
}

/**
 * Consecutive non-blank prose lines, joined by a space, with the 0-based index of the first.
 * @param {string[]} lines
 * @param {boolean[]} prose
 * @param {number} from
 * @param {number} to  exclusive
 */
function paragraphs(lines, prose, from, to) {
  /** @type {{ text: string, index: number }[]} */
  const out = [];
  /** @type {string[]} */
  let current = [];
  let start = from;
  for (let k = from; k <= to; k++) {
    const blank = k === to || !prose[k] || lines[k].trim() === "";
    if (blank) {
      if (current.length > 0) out.push({ text: current.join(" "), index: start });
      current = [];
      continue;
    }
    if (current.length === 0) start = k;
    current.push(lines[k].trim());
  }
  return out;
}

/**
 * The short form of a failure mode carried by the kernel: the bold name it opens with (`**name** ...`), or else
 * its first sentence.
 * @param {string} text
 */
function failureSummary(text) {
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  if (bold) return bold[1].trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(text);
  return (sentence ? sentence[1] : text).trim();
}

/**
 * Parses a principle file: a preface, then principles under `### <mark> : <Name>` headings. After the first
 * principle, any heading of level 1 to 3 that is not a principle heading opens a section (the lattice's "Borders" and
 * "Lattice curation discipline"): sections belong to the file's detail and never to the kernel.
 * @param {string} text
 * @param {string} path
 * @param {Standing} [standing]
 * @returns {PrincipleFile}
 */
export function parsePrincipleText(text, path, standing = "adopted") {
  const slug = slugOf(path);
  const parsed = parseFrontmatter(text, path);
  const frontmatter = checkFrontmatter("principle", parsed.frontmatter, standing, path);
  const lines = parsed.body.split("\n");
  const prose = proseMask(lines);
  /** @type {{ index: number, level: number, title: string }[]} */
  const heads = [];
  for (let k = 0; k < lines.length; k++) {
    const match = prose[k] ? HEADING.exec(lines[k]) : null;
    if (match) heads.push({ index: k, level: match[1].length, title: match[2] });
  }
  const isPrinciple = (/** @type {{ level: number, title: string }} */ head) => head.level === 3 && PRINCIPLE_HEADING.test(head.title);
  const first = heads.findIndex(isPrinciple);
  if (first < 0) throw fail("E_SCHEMA", "a principle file must hold at least one heading of the form `### <mark> : <Name>`", { path });

  /** @type {Principle[]} */
  const principles = [];
  /** @type {Section[]} */
  const sections = [];
  for (let h = first; h < heads.length; h++) {
    const head = heads[h];
    const end = h + 1 < heads.length ? heads[h + 1].index : lines.length;
    const line = parsed.bodyLine + head.index;
    if (!isPrinciple(head)) {
      sections.push({ path, line, title: head.title, text: lines.slice(head.index, end).join("\n").trim() });
      continue;
    }
    const [, mark, name] = /** @type {RegExpExecArray} */ (PRINCIPLE_HEADING.exec(head.title));
    principles.push(parsePrinciple(lines, prose, head.index + 1, end, { path, line, mark, name, bodyLine: parsed.bodyLine }));
  }
  return {
    path,
    slug,
    frontmatter,
    body: parsed.body.trim(),
    preface: lines.slice(0, heads[first].index).join("\n").trim(),
    principles,
    sections,
  };
}

/**
 * @param {string[]} lines
 * @param {boolean[]} prose
 * @param {number} from
 * @param {number} to
 * @param {{ path: string, line: number, mark: string, name: string, bodyLine: number }} at
 * @returns {Principle}
 */
function parsePrinciple(lines, prose, from, to, at) {
  const { path, line, mark, name } = at;
  const blocks = paragraphs(lines, prose, from, to);
  const thesisMatch = blocks.length > 0 ? /^\*(?!\*)(.*[^*\s])\*$/.exec(blocks[0].text) : null;
  if (!thesisMatch) {
    throw fail("E_SCHEMA", `principle ${mark} : ${name} must open with an italic thesis paragraph (*...*)`, {
      path,
      line: blocks.length > 0 ? at.bodyLine + blocks[0].index : line,
    });
  }
  /** @type {Facet[]} */
  const facets = [];
  for (let k = from; k < to; k++) {
    if (!prose[k]) continue;
    const facet = FACET.exec(lines[k]);
    if (facet) {
      facets.push({ name: facet[1].trim(), text: facet[2].trim() });
    } else if (facets.length > 0 && /^[ \t]{2,}\S/.test(lines[k]) && k > from && FACET.test(lines[k - 1])) {
      const last = facets[facets.length - 1];
      last.text = `${last.text} ${lines[k].trim()}`;
    }
  }
  if (facets.length === 0) {
    throw fail("E_SCHEMA", `principle ${mark} : ${name} must list its facets as \`- **<facet>**: <text>\` bullets`, { path, line });
  }
  /** @type {FailureMode | null} */
  let failureMode = null;
  for (const block of blocks) {
    const label = FAILURE_LABEL.exec(block.text);
    if (!label) continue;
    const text = block.text.slice(label[0].length).trim();
    if (text !== "") failureMode = { label: /** @type {"Vice" | "Failure mode"} */ (label[1]), text, summary: failureSummary(text) };
    break;
  }
  return { path, line, mark, name, thesis: thesisMatch[1].trim(), facets, failureMode };
}

/**
 * @typedef {{
 *   path: string, slug: string, frontmatter: Frontmatter, title: string, text: string, body: string,
 *   occasion: string | null, gates: string[],
 * }} Provision
 */

/**
 * Parses a provision: frontmatter, then a body whose first non-blank line is `# <title>`.
 * @param {string} text
 * @param {string} path
 * @param {Standing} [standing]
 * @returns {Provision}
 */
export function parseProvisionText(text, path, standing = "adopted") {
  const slug = slugOf(path);
  const parsed = parseFrontmatter(text, path);
  const frontmatter = checkFrontmatter("provision", parsed.frontmatter, standing, path);
  const lines = parsed.body.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  const title = first < 0 ? null : /^#[ \t]+(.+?)[ \t]*$/.exec(lines[first]);
  if (!title) {
    throw fail("E_SCHEMA", "a provision's body must open with a `# <title>` line", { path, line: parsed.bodyLine + Math.max(first, 0) });
  }
  return {
    path,
    slug,
    frontmatter,
    title: title[1],
    text: lines.slice(first + 1).join("\n").trim(),
    body: parsed.body.trim(),
    occasion: optionalString(frontmatter, "occasion"),
    gates: Array.isArray(frontmatter.gates) ? frontmatter.gates.map(String) : [],
  };
}

/**
 * @typedef {{
 *   path: string, slug: string, frontmatter: Frontmatter, scope: string, summary: string, body: string,
 *   occasion: string | null, falsifiedWhen: string | null, revise: string | null,
 * }} Reflex
 */

/**
 * Parses a reflex: frontmatter carrying its scope and one-line summary, then free text.
 * @param {string} text
 * @param {string} path
 * @param {Standing} [standing]
 * @returns {Reflex}
 */
export function parseReflexText(text, path, standing = "adopted") {
  const slug = slugOf(path);
  const parsed = parseFrontmatter(text, path);
  const frontmatter = checkFrontmatter("reflex", parsed.frontmatter, standing, path);
  return {
    path,
    slug,
    frontmatter,
    scope: String(frontmatter.scope),
    summary: String(frontmatter.summary).trim(),
    body: parsed.body.trim(),
    occasion: optionalString(frontmatter, "occasion"),
    falsifiedWhen: optionalString(frontmatter, "falsified-when"),
    revise: optionalString(frontmatter, "revise"),
  };
}

/**
 * True when a reflex of `scope` loads on `host`: behavioral and architectural reflexes load everywhere, `tool:<host>`
 * reflexes only on that host.
 * @param {string} scope
 * @param {string} host
 */
export function reflexAppliesTo(scope, host) {
  return scope === "behavioral" || scope === "architectural" || scope === `tool:${host}`;
}

/**
 * The body of a plain Markdown file (reflexes/INDEX.md, charter/core.md, purpose.md), with any frontmatter set aside.
 * @param {string} text
 * @param {string} path
 */
export function parsePlainText(text, path) {
  return parseFrontmatter(text, path).body.trim();
}

/** @typedef {{ path: string, text: string, channels: { name: string, text: string }[] }} Voice */

/**
 * Parses voice.md: collaboration manners, with each `## <channel>` section a channel's norms.
 * @param {string} text
 * @param {string} path
 * @returns {Voice}
 */
export function parseVoiceText(text, path) {
  const body = parsePlainText(text, path);
  const lines = body.split("\n");
  const prose = proseMask(lines);
  /** @type {{ name: string, text: string }[]} */
  const channels = [];
  /** @type {{ name: string, start: number } | null} */
  let open = null;
  const close = (/** @type {number} */ end) => {
    if (open) channels.push({ name: open.name, text: lines.slice(open.start, end).join("\n").trim() });
  };
  for (let k = 0; k < lines.length; k++) {
    const match = prose[k] ? /^##[ \t]+(.+?)[ \t]*$/.exec(lines[k]) : null;
    if (!match) continue;
    close(k);
    open = { name: match[1], start: k + 1 };
  }
  close(lines.length);
  return { path, text: body, channels };
}

/**
 * The ask-first lines: `house.toml [charter] ask_first`, an array of one-line strings in the operator's words.
 * @param {import("../config.js").HouseConfig} config
 * @param {string} path  house.toml, named in errors
 * @returns {string[]}
 */
export function askFirstLines(config, path) {
  const value = /** @type {Record<string, unknown> | undefined} */ (config.charter)?.ask_first;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((line) => typeof line !== "string" || line.trim() === "" || line.includes("\n"))) {
    throw fail("E_SCHEMA", "charter.ask_first must be an array of non-empty one-line strings", { path });
  }
  return value.map((line) => line.trim());
}

/** @typedef {{ text: string, long: string | null }} Purpose */

/**
 * The purpose: `house.toml [purpose] text`, and the optional long form in purpose.md.
 * @param {import("../config.js").HouseConfig} config
 * @param {string | null} purposeMd  body of purpose.md, or null when absent
 * @returns {Purpose}
 */
export function purposeOf(config, purposeMd) {
  return { text: (config.purpose?.text ?? "").trim(), long: purposeMd };
}
