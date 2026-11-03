// @ts-check
// Propose and adopt. A proposal waits in proposals/<kind>s/ and is never loaded; adopting moves it into the
// constitution with its provenance (adopted date and the content hash of its body) and records the act in
// charter/record.md. Striking removes the proposal and records its body hash, which is how a struck item is kept
// from being proposed again until its text changes.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "../frontmatter.js";
import { atomicWrite, contentHash, readText } from "../io.js";
import { chars, surfaceOf } from "./budgets.js";
import { compileHouse } from "./compile.js";
import { KIND_DIRS, loadHouse } from "./house.js";
import { parsePrincipleText, parseProvisionText, parseReflexText } from "./parse.js";

/** @typedef {import("./parse.js").Kind} Kind */
/** @typedef {import("./parse.js").Frontmatter} Frontmatter */
/** @typedef {import("./parse.js").Standing} Standing */

export const RECORD_PATH = "charter/record.md";
const RECORD_TEMPLATE = new URL("../../../templates/constitution/charter/record.md", import.meta.url);

/** The budget surface each kind's adopted text lands in. */
export const KIND_SURFACE = Object.freeze({ principle: "principle-detail", provision: "charter-core", reflex: "reflex-index" });

/** @param {Kind} kind @param {string} text @param {string} path @param {Standing} standing */
function parseKind(kind, text, path, standing) {
  if (kind === "principle") return parsePrincipleText(text, path, standing);
  if (kind === "provision") return parseProvisionText(text, path, standing);
  return parseReflexText(text, path, standing);
}

/** The local calendar date as YYYY-MM-DD. @param {Date} [now] */
export function today(now = new Date()) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Frontmatter in the strict YAML subset: every string double-quoted (JSON string escapes are YAML escapes), arrays as
 * one-line flow sequences, so no value can be re-read as a number, boolean or date.
 * @param {Frontmatter} map
 */
export function renderFrontmatter(map) {
  const lines = Object.entries(map).map(([key, value]) =>
    Array.isArray(value) ? `${key}: [${value.map((item) => JSON.stringify(item)).join(", ")}]` : `${key}: ${JSON.stringify(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n`;
}

/** @param {string} root @param {string} rel */
function full(root, rel) {
  return join(root, ...rel.split("/"));
}

/**
 * @typedef {{ date: string, act: "adopted" | "struck", kind: Kind, slug: string, hash: string }} RecordEntry
 */

const RECORD_LINE = /^- ([0-9]{4}-[0-9]{2}-[0-9]{2}) (adopted|struck) (principle|provision|reflex)\/([a-z0-9][a-z0-9-]*) sha256:([0-9a-f]{64})(?: |$)/;

/** @param {string} root @returns {RecordEntry[]} */
export function readRecord(root) {
  const path = full(root, RECORD_PATH);
  if (!existsSync(path)) return [];
  return readText(path)
    .split("\n")
    .map((line) => RECORD_LINE.exec(line))
    .filter((match) => match !== null)
    .map((m) => ({ date: m[1], act: /** @type {"adopted" | "struck"} */ (m[2]), kind: /** @type {Kind} */ (m[3]), slug: m[4], hash: m[5] }));
}

/**
 * @param {string} root
 * @param {RecordEntry & { occasion?: string | null }} entry
 */
function appendRecord(root, entry) {
  const path = full(root, RECORD_PATH);
  const before = existsSync(path) ? readText(path) : readFileSync(RECORD_TEMPLATE, "utf8");
  const occasion = entry.occasion ? ` occasion: ${entry.occasion.replace(/\s+/g, " ")}` : "";
  const line = `- ${entry.date} ${entry.act} ${entry.kind}/${entry.slug} sha256:${entry.hash}${occasion}`;
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${before.endsWith("\n") || before === "" ? before : `${before}\n`}${line}\n`);
}

/**
 * @typedef {{
 *   id: string, kind: Kind, slug: string, path: string, text: string, body: string, hash: string,
 *   occasion: string | null, chars: number, surface: string, surfaceChars: number, cap: number,
 * }} ProposedItem
 */

/**
 * Every proposal in the house, in kind order then code point order of slug, each with its size against the budget
 * of the surface it would land in.
 * @param {string} root
 * @returns {ProposedItem[]}
 */
export function listProposals(root) {
  const house = loadHouse(root);
  const { manifest } = compileHouse(house);
  // A surface measured once per host is reported as its largest instance against the tightest of their caps.
  /** @param {string} surface */
  const instances = (surface) => Object.entries(manifest.surfaces).filter(([key]) => surfaceOf(key) === surface).map(([, size]) => size);
  /** @param {string} surface */
  const current = (surface) => Math.max(0, ...instances(surface).map((size) => size.chars));
  /** @param {string} surface */
  const capFor = (surface) => Math.min(...instances(surface).map((size) => size.cap));
  return house.proposals.map((proposal) => {
    const text = readText(full(root, proposal.path));
    const surface = KIND_SURFACE[proposal.kind];
    const occasion = proposal.frontmatter?.occasion;
    return {
      id: `${proposal.kind}/${proposal.slug}`,
      kind: proposal.kind,
      slug: proposal.slug,
      path: proposal.path,
      text,
      body: proposal.body,
      hash: contentHash(proposal.body),
      occasion: typeof occasion === "string" ? occasion : null,
      chars: chars(text),
      surface,
      surfaceChars: current(surface),
      cap: capFor(surface),
    };
  });
}

/** One line for an item's size against its budget. @param {ProposedItem} item */
export function sizeLine(item) {
  return `${item.id}: ${item.chars} chars; ${item.surface} is ${item.surfaceChars} of ${item.cap}`;
}

/**
 * Adopts one proposal: writes it into the constitution with its provenance, records the act, removes the proposal.
 * Returns a refusal reason instead when the item does not parse as adopted or its destination already exists.
 * @param {string} root
 * @param {ProposedItem} item
 * @param {string} date
 * @returns {string | null}  refusal reason, or null when adopted
 */
export function adoptItem(root, item, date) {
  const destRel = `${KIND_DIRS[item.kind].adopted}/${item.slug}.md`;
  const dest = full(root, destRel);
  if (existsSync(dest)) return `${destRel} already exists`;
  const source = full(root, item.path);
  const parsed = parseFrontmatter(readText(source), source);
  /** @type {Frontmatter} */
  const frontmatter = {};
  if (item.kind === "principle") frontmatter.origin = "own";
  Object.assign(frontmatter, parsed.frontmatter ?? {});
  frontmatter.adopted = date;
  frontmatter["adopted-hash"] = contentHash(parsed.body);
  const text = `${renderFrontmatter(frontmatter)}${parsed.body}`;
  parseKind(item.kind, text, dest, "adopted");
  mkdirSync(dirname(dest), { recursive: true });
  atomicWrite(dest, text);
  appendRecord(root, { date, act: "adopted", kind: item.kind, slug: item.slug, hash: item.hash, occasion: item.occasion });
  rmSync(source, { force: true });
  return null;
}

/**
 * Strikes one proposal: records its body hash and removes it.
 * @param {string} root
 * @param {ProposedItem} item
 * @param {string} date
 */
export function strikeItem(root, item, date) {
  appendRecord(root, { date, act: "struck", kind: item.kind, slug: item.slug, hash: item.hash });
  rmSync(full(root, item.path), { force: true });
}

/**
 * Files a proposal from a draft. The draft's own frontmatter is kept except the keys propose and adopt set; the
 * occasion and proposed date are added. Returns the proposal's house-relative path, or a refusal reason.
 * @param {string} root
 * @param {Kind} kind
 * @param {string} draftPath  absolute
 * @param {string} occasion
 * @param {string} date
 * @returns {{ path: string } | { refused: string }}
 */
export function propose(root, kind, draftPath, occasion, date) {
  const parsed = parseFrontmatter(readText(draftPath), draftPath);
  const name = draftPath.split(/[\\/]/).pop() ?? "";
  const destRel = `${KIND_DIRS[kind].proposals}/${name}`;
  const dest = full(root, destRel);
  /** @type {Frontmatter} */
  const frontmatter = {};
  for (const [key, value] of Object.entries(parsed.frontmatter ?? {})) {
    if (!["occasion", "proposed", "adopted", "adopted-hash"].includes(key)) frontmatter[key] = value;
  }
  frontmatter.occasion = occasion;
  frontmatter.proposed = date;
  const text = `${renderFrontmatter(frontmatter)}${parsed.body}`;
  parseKind(kind, text, dest, "proposal");

  const hash = contentHash(parsed.body);
  const struck = readRecord(root).find((entry) => entry.act === "struck" && entry.kind === kind && entry.hash === hash);
  if (struck) return { refused: `this text was struck as ${kind}/${struck.slug} on ${struck.date}; it is not proposed again unless its text changes` };
  const slug = name.replace(/\.md$/, "");
  if (existsSync(dest)) return { refused: `${destRel} is already proposed` };
  const adoptedRel = `${KIND_DIRS[kind].adopted}/${name}`;
  if (existsSync(full(root, adoptedRel))) return { refused: `${adoptedRel} is already adopted; choose another name for ${kind}/${slug}` };
  mkdirSync(dirname(dest), { recursive: true });
  atomicWrite(dest, text);
  return { path: destRel };
}
