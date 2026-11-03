// @ts-check
// What `lampstand init` plants, and the record of it. Every templates/<set>/manifest.json is read; each entry copies
// its template to its destination when the destination is missing, filling {{name}} placeholders with the
// operator's words verbatim. house.toml is written from the answers, and the lattice pack is copied under its
// provenance frontmatter. A file is planted only when it is missing and was never planted before: a planted file
// that is gone was removed by the operator (a struck lattice, say), and re-planting it would undo their act.
//
// .house/planted.json records every planted file with its hash: the comparator `lampstand upgrade` uses to tell an
// untouched file (safe to replace) from one the operator edited (which gets a proposal instead).
import { tomlString } from "../parse/toml.js";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "../errors.js";
import { atomicWrite, contentHash, readText } from "../io.js";
import { parseHouseToml, HOUSE_SCHEMA_VERSION } from "../config.js";
import { renderFrontmatter } from "../constitution/curate.js";
import { byCodePoint, KIND_DIRS } from "../constitution/house.js";
import { ORG_SCHEMA_FILE } from "../org/schema.js";
import { AGENTS_FILE, blankRegion } from "./region.js";

/** @typedef {import("../config.js").HouseConfig} HouseConfig */
/**
 * @typedef {{ template: string, destination: string, when?: Record<string, string | boolean>, placeholders?: string[] }} ManifestEntry
 * @typedef {{ rel: string, text: string, source: string, values?: Record<string, string> }} PlannedFile
 * @typedef {{ sha256: string, source: string, values?: Record<string, string> }} PlantedRecord
 * @typedef {{ schema: 1, lampstand: string, files: Record<string, PlantedRecord> }} Planted
 */

export const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const VERSION = /** @type {string} */ (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version);

export const PLANTED_FILE = ".house/planted.json";
export const PLANTED_SCHEMA = 1;
export const LATTICE_FILE = "principles/lattice.md";
export const LATTICE_PACK = join(PACKAGE_ROOT, "packs", "lattice", "LATTICE.md");
/** The lattice pack's version, as `origin: pack:lattice@<version>` and `[packs] principles` name it. */
export const LATTICE_VERSION = "1";
export const LATTICE_ORIGIN = `pack:lattice@${LATTICE_VERSION}`;
export const UPDATES_DIR = "proposals/updates";

/**
 * Folders a house holds from the start. Git keeps no empty folder, so these exist on the machine that planted the
 * house; every verb that writes into one creates it again when it is missing.
 */
export const HOUSE_FOLDERS = Object.freeze(
  [
    ...Object.values(KIND_DIRS).flatMap((dirs) => [dirs.adopted, dirs.proposals]),
    UPDATES_DIR,
    ...Object.values(ORG_SCHEMA_FILE.kinds).map((kind) => kind.folder),
  ].sort(byCodePoint),
);

/**
 * House settings a template manifest's `when` may name, with the value the house has when its house.toml leaves
 * the key out; the compiler applies the same default.
 */
const SETTING_DEFAULTS = Object.freeze(/** @type {Record<string, string>} */ ({ "charter.mode": "rules" }));

/** @param {string} root @param {string} rel */
export function fullPath(root, rel) {
  return join(root, ...rel.split("/"));
}

/**
 * The hash planted.json records for a file: its content hash, taken for AGENTS.md with the generated region
 * emptied, since the compiler rewrites that region and only the operator's text counts as an edit.
 * @param {string} rel
 * @param {string} text
 */
export function plantedHash(rel, text) {
  return contentHash(rel === AGENTS_FILE ? blankRegion(text) : text);
}

/** @param {HouseConfig} config @param {string} dotted */
function setting(config, dotted) {
  /** @type {unknown} */
  let value = config;
  for (const key of dotted.split(".")) {
    value = typeof value === "object" && value !== null ? /** @type {Record<string, unknown>} */ (value)[key] : undefined;
  }
  return value === undefined ? SETTING_DEFAULTS[dotted] : value;
}

/**
 * Every template manifest in the package, by set name (the folder under templates/), in code point order.
 * @returns {{ set: string, entries: ManifestEntry[] }[]}
 */
function manifests() {
  const dir = join(PACKAGE_ROOT, "templates");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "manifest.json")))
    .map((entry) => entry.name)
    .sort(byCodePoint)
    .map((set) => ({ set, entries: JSON.parse(readText(join(dir, set, "manifest.json"))).files }));
}

/**
 * @param {string} text
 * @param {string[]} names
 * @param {Record<string, string>} values
 * @param {string} source
 */
function fill(text, names, values, source) {
  let out = text;
  for (const name of names) {
    const value = values[name];
    if (value === undefined) throw new Error(`${source} needs a value for {{${name}}}`);
    const token = `{{${name}}}`;
    // An empty answer takes its placeholder's line with it, so a declined question leaves no blank lines behind.
    out = value === "" ? out.replace(new RegExp(`^[ \\t]*\\{\\{${name}\\}\\}[ \\t]*\\n?`, "m"), "").replaceAll(token, "") : out.replaceAll(token, value);
  }
  return out;
}

/**
 * The template files this lampstand plants into a house configured by `config`.
 * @param {HouseConfig} config
 * @param {Record<string, string>} values  placeholder values by name
 * @returns {PlannedFile[]}
 */
export function templateFiles(config, values) {
  /** @type {PlannedFile[]} */
  const out = [];
  for (const { set, entries } of manifests()) {
    for (const entry of entries) {
      const applies = Object.entries(entry.when ?? {}).every(([key, wanted]) => setting(config, key) === wanted);
      if (!applies) continue;
      const source = `${set}/${entry.template}`;
      const raw = readText(join(PACKAGE_ROOT, "templates", set, ...entry.template.split("/")));
      const names = entry.placeholders ?? [];
      /** @type {PlannedFile} */
      const file = { rel: entry.destination, text: fill(raw, names, values, source), source };
      if (names.length > 0) file.values = Object.fromEntries(names.map((name) => [name, values[name]]));
      out.push(file);
    }
  }
  return out;
}

/**
 * principles/lattice.md as planted: the pack verbatim under its provenance frontmatter.
 * @param {string} date  YYYY-MM-DD
 * @returns {PlannedFile}
 */
export function latticeFile(date) {
  const pack = readText(LATTICE_PACK);
  const text = `${renderFrontmatter({ origin: LATTICE_ORIGIN, adopted: date, "adopted-hash": contentHash(pack) })}${pack}`;
  return { rel: LATTICE_FILE, text, source: LATTICE_ORIGIN };
}


/**
 * @typedef {{
 *   name: string,
 *   operator: string,
 *   coOwners: string[],
 *   purpose: string,
 *   charter: "none" | "rules" | "agreement",
 *   askFirst: string[],
 *   channelManners: string,
 *   lattice: boolean,
 * }} Answers
 */

/**
 * house.toml from the answers. The text is re-read through the house.toml parser and schema before anything is
 * planted, so an answer the house would refuse (a purpose over 600 characters) stops init before its first write.
 * @param {Answers} answers
 * @param {string} id  a fresh UUID
 * @param {string} path  where it will be written, named in a refusal
 */
export function houseTomlText(answers, id, path) {
  const list = (/** @type {string[]} */ items) => `[${items.map(tomlString).join(", ")}]`;
  const lines = [
    "# The marker and manifest of this house. lampstand reads it and never rewrites it; edit it freely.",
    "[house]",
    `schema = ${HOUSE_SCHEMA_VERSION}`,
    `id = "${id}"`,
    `name = ${tomlString(answers.name)}`,
    "",
    "[operator]",
    ...(answers.operator === "" ? [] : [`name = ${tomlString(answers.operator)}`]),
    `co_owners = ${list(answers.coOwners)}`,
    "",
    "[purpose]",
    `text = ${tomlString(answers.purpose)}`,
    "",
    "[charter]",
    `mode = ${tomlString(answers.charter)}`,
    `ask_first = ${list(answers.askFirst)}`,
    "",
    "[budget]",
    `profile = "${answers.lattice ? "large" : "standard"}"`,
    "",
    "[modules]",
    "scheduler = false",
    "rooms = false",
    "residents = false",
    "watchdog = false",
    "orchestration = true",
    "",
    "[gate]",
    'mode = "remind"',
    "",
    "[plugin]",
    `min = "${VERSION}"`,
    ...(answers.lattice ? ["", "[packs]", `principles = "${LATTICE_VERSION}"`] : []),
  ];
  const text = `${lines.join("\n")}\n`;
  parseHouseToml(text, path);
  return text;
}

/**
 * planted.json, or an empty record when the house has none.
 * @param {string} root
 * @returns {Planted}
 */
export function readPlanted(root) {
  const path = fullPath(root, PLANTED_FILE);
  if (!existsSync(path)) return { schema: PLANTED_SCHEMA, lampstand: VERSION, files: {} };
  let data;
  try {
    data = JSON.parse(readText(path));
  } catch (cause) {
    throw fail("E_SCHEMA", `planted.json is not valid JSON: ${/** @type {Error} */ (cause).message}`, { path, cause });
  }
  if (typeof data?.schema === "number" && data.schema > PLANTED_SCHEMA) {
    throw fail("E_SCHEMA_NEWER", `planted.json schema ${data.schema} is newer than this lampstand understands (${PLANTED_SCHEMA})`, { path });
  }
  if (data?.schema !== PLANTED_SCHEMA || typeof data.files !== "object" || data.files === null || Array.isArray(data.files)) {
    throw fail("E_SCHEMA", `planted.json must be an object with schema ${PLANTED_SCHEMA} and a files object`, { path });
  }
  for (const [rel, record] of Object.entries(data.files)) {
    if (typeof record?.sha256 !== "string" || typeof record.source !== "string") {
      throw fail("E_SCHEMA", `planted.json files.${rel} must carry sha256 and source strings`, { path });
    }
  }
  return /** @type {Planted} */ (data);
}

/**
 * Writes planted.json when its files differ from what is on disk; keys in code point order, so the bytes depend only
 * on the record. Returns whether it wrote.
 * @param {string} root
 * @param {Planted} planted
 */
export function writePlanted(root, planted) {
  const path = fullPath(root, PLANTED_FILE);
  const files = Object.fromEntries(Object.keys(planted.files).sort(byCodePoint).map((rel) => [rel, planted.files[rel]]));
  if (existsSync(path) && JSON.stringify(readPlanted(root).files) === JSON.stringify(files)) return false;
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify({ schema: PLANTED_SCHEMA, lampstand: VERSION, files }, null, 2)}\n`);
  return true;
}

/**
 * Writes `file` when it is missing and planted.json has no record of it, then records it.
 * @param {string} root
 * @param {Planted} planted
 * @param {PlannedFile} file
 * @returns {"planted" | "kept" | "removed"}  kept: the file exists; removed: it was planted once and is gone
 */
export function plantFile(root, planted, file) {
  const path = fullPath(root, file.rel);
  if (existsSync(path)) return "kept";
  if (planted.files[file.rel] !== undefined) return "removed";
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, file.text);
  planted.files[file.rel] = { sha256: plantedHash(file.rel, file.text), source: file.source, ...(file.values ? { values: file.values } : {}) };
  return "planted";
}
