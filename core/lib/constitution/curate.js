// @ts-check
// Propose and adopt. A proposal waits in proposals/<kind>s/ and is never loaded; adopting moves it into the
// constitution with its provenance (adopted date and the content hash of its body) and records the act in
// charter/record.md. Striking removes the proposal and records its body hash, which is how a struck item is kept
// from being proposed again until its text changes.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail, isLampstandError } from "../errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import { validate } from "../config.js";
import { atomicWrite, contentHash, readText } from "../io.js";
import { localDate } from "../org/markdown.js";
import { chars, surfaceOf } from "./budgets.js";
import { compileHouse } from "./compile.js";
import { PROPOSAL_EXAMPLES } from "./examples.js";
import { KIND_DIRS, loadHouse } from "./house.js";
import { parsePrincipleText, parseProvisionText, parseReflexText, SCHEMAS } from "./parse.js";
import { CURATION_RULES, KNOWN_GATES } from "./rules.js";

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

/** The local calendar date as YYYY-MM-DD; the org's own helper, so every dated act shares one "today". */
export const today = localDate;

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
 * @typedef {{ date: string, act: "adopted" | "struck", kind: Kind | "update", slug: string, hash: string }} RecordEntry
 *   An update proposal (the new text of a planted file) is recorded as kind `update` with the target's path as slug.
 */

const RECORD_LINE = /^- ([0-9]{4}-[0-9]{2}-[0-9]{2}) (adopted|struck) (principle|provision|reflex|update)\/([A-Za-z0-9][A-Za-z0-9._\/-]*) sha256:([0-9a-f]{64})(?: |$)/;

/** @param {string} root @returns {RecordEntry[]} */
export function readRecord(root) {
  const path = full(root, RECORD_PATH);
  if (!existsSync(path)) return [];
  return readText(path)
    .split("\n")
    .map((line) => RECORD_LINE.exec(line))
    .filter((match) => match !== null)
    .map((m) => ({ date: m[1], act: /** @type {"adopted" | "struck"} */ (m[2]), kind: /** @type {Kind | "update"} */ (m[3]), slug: m[4], hash: m[5] }));
}

/**
 * @param {string} root
 * @param {RecordEntry & { occasion?: string | null }} entry
 */
export function appendRecord(root, entry) {
  const path = full(root, RECORD_PATH);
  const before = existsSync(path) ? readText(path) : readFileSync(RECORD_TEMPLATE, "utf8");
  const occasion = entry.occasion ? ` occasion: ${entry.occasion.replace(/\s+/g, " ")}` : "";
  const line = `- ${entry.date} ${entry.act} ${entry.kind}/${entry.slug} sha256:${entry.hash}${occasion}`;
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${before.endsWith("\n") || before === "" ? before : `${before}\n`}${line}\n`);
}

/**
 * @typedef {{
 *   id: string, kind: Kind | "update", slug: string, path: string, text: string, body: string, hash: string,
 *   occasion: string | null, chars: number, surface: string, surfaceChars: number, cap: number,
 *   update?: UpdateOffer,
 * }} ProposedItem
 *   `surface` is empty for an item with no budget to measure it against. An item of kind `update` is an offered new
 *   text for a planted file (see updates.js); `hash` is then the offer's `upstream-sha256`.
 * @typedef {{
 *   target: string, upstream: string | null, textSha: string | null, targetSha: string | null, planted: string | null,
 * }} UpdateOffer
 */

/**
 * How full each budget surface is now. A surface measured once per host is reported as its largest instance against
 * the tightest of their caps.
 * @param {import("./house.js").House} house
 */
export function surfaceMeter(house) {
  const { manifest } = compileHouse(house);
  /** @param {string} surface */
  const instances = (surface) => Object.entries(manifest.surfaces).filter(([key]) => surfaceOf(key) === surface).map(([, size]) => size);
  return {
    /** @param {string} surface */
    current: (surface) => Math.max(0, ...instances(surface).map((size) => size.chars)),
    /** @param {string} surface */
    capFor: (surface) => Math.min(...instances(surface).map((size) => size.cap)),
  };
}

/**
 * Every proposal in the house, in kind order then code point order of slug, each with its size against the budget
 * of the surface it would land in.
 * @param {string} root
 * @returns {ProposedItem[]}
 */
export function listProposals(root) {
  const house = loadHouse(root);
  const { current, capFor } = surfaceMeter(house);
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
  return item.surface === "" ? `${item.id}: ${item.chars} chars` : `${item.id}: ${item.chars} chars; ${item.surface} is ${item.surfaceChars} of ${item.cap}`;
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
  const kind = /** @type {Kind} */ (item.kind);
  const destRel = `${KIND_DIRS[kind].adopted}/${item.slug}.md`;
  const dest = full(root, destRel);
  if (existsSync(dest)) return `${destRel} already exists`;
  const source = full(root, item.path);
  const parsed = parseFrontmatter(readText(source), source);
  /** @type {Frontmatter} */
  const frontmatter = {};
  if (kind === "principle") frontmatter.origin = "own";
  Object.assign(frontmatter, parsed.frontmatter ?? {});
  frontmatter.adopted = date;
  frontmatter["adopted-hash"] = contentHash(parsed.body);
  const text = `${renderFrontmatter(frontmatter)}${parsed.body}`;
  parseKind(kind, text, dest, "adopted");
  mkdirSync(dirname(dest), { recursive: true });
  atomicWrite(dest, text);
  appendRecord(root, { date, act: "adopted", kind, slug: item.slug, hash: item.hash, occasion: item.occasion });
  rmSync(source, { force: true });
  return null;
}

/**
 * The house-relative paths an act on `item` writes, moves or deletes: the record, the proposal's old place and, for
 * an adoption, its new one.
 * @param {ProposedItem} item
 * @param {"adopted" | "struck"} act
 * @returns {string[]}
 */
export function actPaths(item, act) {
  return act === "adopted" ? [RECORD_PATH, item.path, `${KIND_DIRS[/** @type {Kind} */ (item.kind)].adopted}/${item.slug}.md`] : [RECORD_PATH, item.path];
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
 * The file name a proposal must have, checked before anything is read or written: a slug of lowercase letters, digits
 * and hyphens, then `.md`. A refusal names the nearest valid name: extra dots (`x.draft.md`) are cut, and anything
 * else outside the slug's characters becomes a hyphen.
 * @param {string} name  the draft's base name
 * @param {string} path  named in the refusal
 */
function checkProposalName(name, path) {
  if (/^[a-z0-9][a-z0-9-]*\.md$/.test(name)) return;
  const stem = name.replace(/\.md$/i, "");
  const slug = (/** @type {string} */ text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const suggestion = slug(stem.split(".")[0]) || slug(stem);
  const hint = suggestion === "" ? "name it <slug>.md" : `try ${suggestion}.md`;
  throw fail("E_SCHEMA", `the draft's file name must be lowercase letters, digits and hyphens before .md, found ${JSON.stringify(name)}; ${hint}`, { path });
}

/**
 * The keys propose and adopt write themselves; an author's value for one is replaced, never checked.
 */
const SET_BY_LAMPSTAND = Object.freeze(["occasion", "proposed", "adopted", "adopted-hash"]);

/** The curation rules that judge one item on its own text, run on a draft as the compiler runs them on the house. */
const ITEM_RULES = Object.freeze(["failure-mode", "reflex-revisable", "provision-gates"]);

/**
 * A parser's reason without the `path:line:` it leads with: in a draft's refusal every problem is the draft's own,
 * and a line counted in the text propose rebuilt would not be the author's line.
 * @param {import("../errors.js").LampstandError} error
 * @param {boolean} [keepLine]  the error was raised on the author's own text, so its line is theirs
 */
function reasonOf(error, keepLine = false) {
  if (error.path === undefined) return error.message;
  const where = error.line === undefined ? `${error.path}: ` : `${error.path}:${error.line}: `;
  const reason = error.message.startsWith(where) ? error.message.slice(where.length) : error.message;
  return keepLine && error.line !== undefined ? `line ${error.line}: ${reason}` : reason;
}

/**
 * Every reason a draft of `kind` would be refused at propose, adopt or the compile after it, in one list (empty when
 * it would pass): the frontmatter against the kind's schema (each missing required key, each unknown key, each bad
 * value), the body's structure, and the item-level curation rules.
 * @param {Kind} kind
 * @param {string} text  the draft as the author wrote it
 * @param {string} path  where it would be filed, named in parser messages
 * @returns {string[]}
 */
export function draftProblems(kind, text, path) {
  /** @type {string[]} */
  const problems = [];
  let parsed;
  try {
    parsed = parseFrontmatter(text, path);
  } catch (error) {
    if (!isLampstandError(error)) throw error;
    return [reasonOf(error, true)];
  }
  const frontmatter = parsed.frontmatter ?? {};
  const schema = SCHEMAS[kind];
  const properties = /** @type {Record<string, import("../config.js").Schema>} */ (schema.properties ?? {});
  // Adopt adds `origin: own` to a principle that names none.
  const required = (schema.required ?? []).filter((key) => !SET_BY_LAMPSTAND.includes(key) && !(kind === "principle" && key === "origin"));
  if (parsed.frontmatter === null && required.length > 0) problems.push(`a ${kind} draft must open with a frontmatter block (--- lines)`);
  const missing = required.filter((key) => frontmatter[key] === undefined);
  if (missing.length > 0) problems.push(`frontmatter is missing ${missing.map((key) => `\`${key}\``).join(", ")}`);
  /** @type {Frontmatter} */
  const valid = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (SET_BY_LAMPSTAND.includes(key)) continue;
    if (!Object.hasOwn(properties, key)) {
      const known = Object.keys(properties).filter((name) => !SET_BY_LAMPSTAND.includes(name));
      problems.push(`frontmatter key \`${key}\` is not one a ${kind} carries (${known.join(", ")})`);
      continue;
    }
    try {
      validate({ type: "object", properties: { [key]: properties[key] } }, { [key]: value }, path);
      valid[key] = value;
    } catch (error) {
      if (!isLampstandError(error)) throw error;
      problems.push(reasonOf(error));
    }
  }
  // The body is parsed under a frontmatter that is valid by construction, so a body fault is reported beside the
  // frontmatter faults rather than hidden behind the first of them.
  /** @type {Frontmatter} */
  const stand = kind === "reflex" ? { scope: "behavioral", summary: "draft", ...valid, proposed: "2000-01-01" } : { ...valid, proposed: "2000-01-01" };
  let item;
  try {
    item = parseKind(kind, `${renderFrontmatter(stand)}${parsed.body}`, path, "proposal");
  } catch (error) {
    if (!isLampstandError(error)) throw error;
    problems.push(reasonOf(error));
    if (kind === "principle") problems.push(...principleShape(parsed.body, error.message));
    return problems;
  }
  const house = /** @type {any} */ ({
    proposals: [],
    principleFiles: kind === "principle" ? [item] : [],
    provisions: kind === "provision" ? [item] : [],
    reflexes: kind === "reflex" ? [item] : [],
  });
  for (const rule of CURATION_RULES.filter((candidate) => ITEM_RULES.includes(candidate.id))) {
    for (const finding of rule.check(/** @type {any} */ ({ house, gates: KNOWN_GATES }))) {
      if (finding.level === "error") problems.push(finding.message);
    }
  }
  return problems;
}

/**
 * What else a principle body lacks once the parser has refused it for `already`: the parser stops at its first fault,
 * so the remaining parts of the shape are looked for directly.
 * @param {string} body
 * @param {string} already  the parser's message
 */
function principleShape(body, already) {
  const lines = body.split("\n").map((line) => line.trim());
  const out = [];
  if (!/heading/.test(already) && !lines.some((line) => /^### \S(?:.*\S)? : \S/.test(line))) {
    out.push("a principle file must hold at least one heading of the form `### <mark> : <Name>`");
  }
  if (!/thesis/.test(already) && !lines.some((line) => /^\*(?!\*)(?!Kernel:\*|Vice:\*|Failure mode:\*).*[^*\s]\*$/.test(line))) {
    out.push("a principle must open with an italic thesis paragraph (*...*)");
  }
  if (!/facets/.test(already) && !lines.some((line) => /^[-*] \*\*.+?\*\*:[ \t]+\S/.test(line))) {
    out.push("a principle must list its facets as `- **<facet>**: <text>` bullets");
  }
  if (!lines.some((line) => /^\*(Vice|Failure mode):\*/.test(line))) out.push("a principle needs a `*Failure mode:*` (or `*Vice:*`) paragraph");
  return out;
}

/**
 * The refusal for a draft with problems: each problem, then the shape a draft of the kind takes.
 * @param {Kind} kind
 * @param {string[]} problems
 */
export function draftRefusal(kind, problems) {
  const example = PROPOSAL_EXAMPLES[kind];
  return [
    `the draft is not a ${kind} lampstand can adopt (${problems.length} problem${problems.length === 1 ? "" : "s"}):`,
    ...problems.map((problem) => `- ${problem}`),
    `A ${kind} draft looks like this (propose adds occasion and proposed itself):`,
    ...example.text.trimEnd().split("\n").map((line) => `    ${line}`),
    ...example.notes,
  ].join("\n");
}

/**
 * Files a proposal from a draft. The draft's own frontmatter is kept except the keys propose and adopt set; the
 * occasion and proposed date are added. A draft already written at its destination, with no occasion yet, is
 * finalized in place; one that carries an occasion is already proposed. Returns the proposal's house-relative path, or
 * a refusal reason.
 * @param {string} root
 * @param {Kind} kind
 * @param {string} draftPath  absolute
 * @param {string} occasion
 * @param {string} date
 * @returns {{ path: string } | { refused: string }}
 */
export function propose(root, kind, draftPath, occasion, date) {
  const name = draftPath.split(/[\\/]/).pop() ?? "";
  checkProposalName(name, draftPath);
  const raw = readText(draftPath);
  const destRel = `${KIND_DIRS[kind].proposals}/${name}`;
  const dest = full(root, destRel);
  // Every check adoption and the compiler would apply to this item, all at once: a draft that passes here is one
  // adopt can take, and an author fixes every field in one pass rather than one refusal at a time.
  const problems = draftProblems(kind, raw, dest);
  if (problems.length > 0) throw fail("E_SCHEMA", draftRefusal(kind, problems), { path: draftPath });
  const parsed = parseFrontmatter(raw, draftPath);
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
  const inPlace = existsSync(dest) && realpathSync.native(dest) === realpathSync.native(draftPath);
  const occasionHere = parsed.frontmatter?.occasion;
  const finalizing = inPlace && !(typeof occasionHere === "string" && occasionHere.trim() !== "");
  if (existsSync(dest) && !finalizing) return { refused: `${destRel} is already proposed` };
  const adoptedRel = `${KIND_DIRS[kind].adopted}/${name}`;
  if (existsSync(full(root, adoptedRel))) return { refused: `${adoptedRel} is already adopted; choose another name for ${kind}/${slug}` };
  mkdirSync(dirname(dest), { recursive: true });
  atomicWrite(dest, text);
  return { path: destRel };
}
