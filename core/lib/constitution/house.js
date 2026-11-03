// @ts-check
// Reads L0 to L6 of a house into one parsed value. This is the only place the constitution touches the filesystem
// for reading inputs, so the compiler and the curation rules are pure functions of what it returns.
//
// The input hash is defined over files a reader without a YAML or TOML parser can find: the header of every
// projection names the input specs, a spec ending in `/*.md` means every regular `*.md` file directly in that
// directory, files are taken in code point order of their house-relative path, and the hash is sha256 over the
// UTF-8 of `<path>\n<content-hash>\n` per present file, where content-hash is io.js contentHash. A Python loader
// recomputes it from the header alone; schema/constitution/input-hash.json pins the definition for both.
//
// house.toml is hashed as the compiler reads it, not byte for byte: the tables no projection is built from (see
// UNPROJECTED_TABLES) and every comment-only or blank line are left out, so declaring a job or turning a module on
// does not make the projections stale. The rule is line-based on purpose, so the Python loader needs no TOML parser.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadHouseConfig } from "../config.js";
import { parseFrontmatter } from "../frontmatter.js";
import { contentHash, normalizeLf, readText, stripBom } from "../io.js";
import {
  askFirstLines,
  KINDS,
  parsePlainText,
  parsePrincipleText,
  parseProvisionText,
  parseReflexText,
  parseVoiceText,
  purposeOf,
  slugOf,
} from "./parse.js";

/** The compiler's inputs, in hash order. Everything a projection carries comes from exactly these files. */
export const INPUT_SPECS = Object.freeze([
  "house.toml",
  "principles/*.md",
  "charter/core.md",
  "charter/provisions/*.md",
  "reflexes/*.md",
  "voice.md",
]);

/**
 * The house.toml tables the compiler never reads. Everything else in house.toml is hashed, so a key the compiler
 * starts to read later is covered by default; a key in one of these tables must not be read by it.
 */
export const UNPROJECTED_TABLES = Object.freeze(["jobs", "modules", "gate"]);

/**
 * The text of a file as the input hash sees it: the file itself, except house.toml, which loses its unprojected
 * tables (a header line `[name...]` or `[[name...]]` whose first key is one of UNPROJECTED_TABLES, and the lines up to
 * the next header) and every blank or `#` comment line. A header's first key is the text after the brackets and
 * blanks up to the next `.`, `]` or blank, with one pair of surrounding quotes removed.
 * @param {string} path  house-relative
 * @param {string} text  LF-normalized, without a BOM
 */
export function hashedText(path, text) {
  if (path !== "house.toml") return text;
  let skipping = false;
  /** @type {string[]} */
  const kept = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      const first = trimmed.replace(/^\[+[ \t]*/, "").split(/[.\] \t]/, 1)[0].replace(/^(["'])(.*)\1$/, "$2");
      skipping = UNPROJECTED_TABLES.includes(first);
    }
    if (!skipping) kept.push(line);
  }
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

/** Where each kind waits before adoption, and where adoption moves it. */
export const KIND_DIRS = Object.freeze({
  principle: { proposals: "proposals/principles", adopted: "principles" },
  provision: { proposals: "proposals/provisions", adopted: "charter/provisions" },
  reflex: { proposals: "proposals/reflexes", adopted: "reflexes" },
});

/** Code point order, which is also UTF-8 byte order and Python's default string order. @param {string} a @param {string} b */
export function byCodePoint(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * House-relative paths of the regular `*.md` files directly in `dir`, in code point order; empty when absent.
 * @param {string} root
 * @param {string} dir  house-relative, `/`-separated
 */
export function markdownFiles(root, dir) {
  const full = join(root, ...dir.split("/"));
  if (!isDirectory(full)) return [];
  return readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `${dir}/${entry.name}`)
    .sort(byCodePoint);
}

/** @param {string} path */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} root @param {string} rel */
function exists(root, rel) {
  return existsSync(join(root, ...rel.split("/")));
}

/** @param {string} root @param {string} rel */
function read(root, rel) {
  return readText(join(root, ...rel.split("/")));
}

/**
 * Every present input file, expanded from INPUT_SPECS, with its text.
 * @param {string} root
 * @returns {{ path: string, text: string }[]}
 */
export function readInputs(root) {
  const paths = INPUT_SPECS.flatMap((spec) =>
    spec.endsWith("/*.md") ? markdownFiles(root, spec.slice(0, -"/*.md".length)) : exists(root, spec) ? [spec] : [],
  );
  return paths.map((path) => ({ path, text: read(root, path) }));
}

/** @param {{ path: string, text: string }[]} inputs */
export function inputHash(inputs) {
  const hash = createHash("sha256");
  for (const input of inputs) hash.update(`${input.path}\n${contentHash(hashedText(input.path, normalizeLf(stripBom(input.text))))}\n`, "utf8");
  return hash.digest("hex");
}

/**
 * @typedef {import("./parse.js").PrincipleFile} PrincipleFile
 * @typedef {import("./parse.js").Provision} Provision
 * @typedef {import("./parse.js").Reflex} Reflex
 * @typedef {import("./parse.js").Kind} Kind
 * @typedef {{ kind: Kind, slug: string, path: string, frontmatter: import("./parse.js").Frontmatter | null, body: string }} Proposal
 * @typedef {{
 *   root: string,
 *   config: import("../config.js").HouseConfig,
 *   profile: "lean" | "standard" | "large",
 *   mode: "none" | "rules" | "agreement",
 *   surfaces: Record<string, unknown> | null,
 *   purpose: import("./parse.js").Purpose,
 *   askFirst: string[],
 *   principleFiles: PrincipleFile[],
 *   charterCore: string | null,
 *   provisions: Provision[],
 *   reflexIndex: string | null,
 *   reflexes: Reflex[],
 *   voice: import("./parse.js").Voice | null,
 *   proposals: Proposal[],
 *   inputs: string[],
 *   inputHash: string,
 * }} House
 */

/**
 * Reads and parses every constitution file of the house at `root`. Proposals are read for their frontmatter only:
 * they are never loaded into a projection, and adopt parses each one fully before moving it.
 * @param {string} root
 * @returns {House}
 */
export function loadHouse(root) {
  const config = loadHouseConfig(root);
  const inputs = readInputs(root);
  const text = new Map(inputs.map((input) => [input.path, input.text]));
  const under = (/** @type {string} */ dir) => inputs.filter((input) => input.path.startsWith(`${dir}/`));
  const full = (/** @type {string} */ rel) => join(root, ...rel.split("/"));

  /** @type {Proposal[]} */
  const proposals = [];
  for (const kind of KINDS) {
    for (const rel of markdownFiles(root, KIND_DIRS[kind].proposals)) {
      const parsed = parseFrontmatter(read(root, rel), full(rel));
      proposals.push({ kind, slug: slugOf(full(rel)), path: rel, frontmatter: parsed.frontmatter, body: parsed.body });
    }
  }

  const surfaces = /** @type {Record<string, unknown>} */ (config).surfaces;
  return {
    root,
    config,
    profile: config.budget?.profile ?? "standard",
    mode: config.charter?.mode ?? "rules",
    surfaces: typeof surfaces === "object" && surfaces !== null ? /** @type {Record<string, unknown>} */ (surfaces) : null,
    purpose: purposeOf(config, exists(root, "purpose.md") ? parsePlainText(read(root, "purpose.md"), full("purpose.md")) : null),
    askFirst: askFirstLines(config, full("house.toml")),
    principleFiles: under("principles").map((input) => parsePrincipleText(input.text, full(input.path))),
    charterCore: text.has("charter/core.md") ? parsePlainText(/** @type {string} */ (text.get("charter/core.md")), full("charter/core.md")) : null,
    provisions: under("charter/provisions").map((input) => parseProvisionText(input.text, full(input.path))),
    reflexIndex: text.has("reflexes/INDEX.md") ? parsePlainText(/** @type {string} */ (text.get("reflexes/INDEX.md")), full("reflexes/INDEX.md")) : null,
    reflexes: under("reflexes")
      .filter((input) => input.path !== "reflexes/INDEX.md")
      .map((input) => parseReflexText(input.text, full(input.path))),
    voice: text.has("voice.md") ? parseVoiceText(/** @type {string} */ (text.get("voice.md")), full("voice.md")) : null,
    proposals,
    inputs: inputs.map((input) => input.path),
    inputHash: inputHash(inputs),
  };
}
