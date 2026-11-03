// @ts-check
// The org schema: the defaults in schema/org.json merged with house.toml [org]. A house may add kinds, statuses and
// folders but never remove or redefine a default's folder, initial status or required fields. It may also say how a
// house that predates lampstand names and places its items: the field that names the kind and its value per kind, a
// title read from the first heading, folders read with their subfolders, a folder per status, the names its items
// give the fields lampstand reads and writes, whether a terminal item needs a resolution line, which files in org
// folders are not items, and whether a file there without frontmatter is an error.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOUSE_SCHEMA, HOUSE_SCHEMA_VERSION, parseHouseToml, validate } from "../config.js";
import { fail } from "../errors.js";
import { readText } from "../io.js";
import { parseToml } from "../parse/toml.js";

/** @typedef {import("../config.js").Schema} Schema */
/** @typedef {import("../parse/toml.js").TomlTable} TomlTable */
/**
 * @typedef {{
 *   folder: string,
 *   statuses: string[],
 *   terminal: string[],
 *   initial: string,
 *   required: string[],
 * }} DefaultKind
 * @typedef {{
 *   version: number,
 *   resolved_folder: string,
 *   resolved_fields: Field[],
 *   kinds: Record<string, DefaultKind>,
 *   house_toml: Schema,
 * }} OrgSchemaFile
 * @typedef {Partial<DefaultKind> & {
 *   folders?: string[],
 *   kind_value?: string,
 *   nested?: boolean,
 *   status_folders?: Record<string, string>,
 *   lists?: string[],
 *   fields?: Partial<Record<Field, string>>,
 *   resolution_required?: boolean,
 * }} KindTable
 * @typedef {{
 *   kind_field?: string,
 *   title_fallback?: "heading",
 *   not_items?: string[],
 *   missing_frontmatter?: "info" | "error",
 *   kinds?: Record<string, KindTable>,
 * }} OrgTable
 * @typedef {"title" | "status" | "created" | "due" | "resolved" | "resolution"} Field
 *   A field lampstand itself reads or writes, by lampstand's name for it.
 * @typedef {{
 *   name: string,
 *   value: string,
 *   folder: string,
 *   folders: string[],
 *   statuses: string[],
 *   terminal: string[],
 *   initial: string,
 *   required: string[],
 *   nested: boolean,
 *   statusFolders: Map<string, string>,
 *   implied: Map<string, string>,
 *   lists: string[],
 *   fields: Map<string, string>,
 *   resolutionRequired: boolean,
 *   places: Place[],
 * }} Kind
 *   `folder` is where new items are written; `folders` is every home folder items of the kind live in, `folder`
 *   first. `value` is what the kind field holds for this kind. `statusFolders` maps a status to the folder its items
 *   live in; `implied` maps a folder named by exactly one status there to that status. `places` is every folder the
 *   kind's items are read from. `required` names logical fields: `kind` is the schema's kind field, and a name in
 *   `fields` is read under the house's name for it. `resolutionRequired` is false when a terminal item of the kind
 *   needs a resolved date but no resolution line.
 * @typedef {{ dir: string, home: string }} Place
 *   A folder items are read from, and the home folder whose items it holds.
 * @typedef {{
 *   kinds: Map<string, Kind>,
 *   byFolder: Map<string, Kind>,
 *   byPlace: Map<string, Kind>,
 *   resolvedFolder: string,
 *   resolvedFields: Field[],
 *   kindField: string,
 *   titleFallback: "heading" | null,
 *   notItems: RegExp[],
 *   missingFrontmatter: "info" | "error",
 * }} OrgSchema
 *   `notItems` matches the house-relative paths of files in org folders that are not items.
 * @typedef {{ path: string, data: TomlTable, lines: Map<string, number> }} HouseToml
 */

export const ORG_SCHEMA_FILE = /** @type {OrgSchemaFile} */ (
  JSON.parse(readFileSync(new URL("../../../schema/org.json", import.meta.url), "utf8"))
);

const KIND_NAME = /^[a-z][a-z0-9-]*$/;
const DEFAULT_REQUIRED = Object.freeze(["kind", "title", "status", "created"]);

/** The fields lampstand reads or writes besides the kind field, which `fields` may rename per kind. */
const FIELDS = /** @type {const} */ (["title", "status", "created", "due", "resolved", "resolution"]);

/**
 * Reads house.toml as raw TOML. A newer house.schema is refused through config.js so the message lives in one place;
 * the rest of the document is not validated here, since each module validates the tables it reads.
 * @param {string} root
 * @returns {HouseToml}
 */
export function readHouseToml(root) {
  const path = join(root, "house.toml");
  const text = readText(path);
  /** @type {Map<string, number>} */
  const lines = new Map();
  const data = parseToml(text, path, { lines });
  const head = data.house;
  const version = typeof head === "object" && head !== null && !Array.isArray(head) ? head.schema : undefined;
  if (typeof version === "number" && Number.isInteger(version) && version > HOUSE_SCHEMA_VERSION) parseHouseToml(text, path);
  return { path, data, lines };
}

/**
 * The `[gate] mode` of the house, validated against house.schema.json; `remind` when absent.
 * @param {HouseToml} house
 * @returns {"off" | "remind" | "block"}
 */
export function gateModeOf(house) {
  const gateSchema = HOUSE_SCHEMA.properties?.gate;
  if (gateSchema && house.data.gate !== undefined) {
    validate({ type: "object", properties: { gate: gateSchema } }, { gate: house.data.gate }, house.path, house.lines);
  }
  const gate = /** @type {{ mode?: "off" | "remind" | "block" } | undefined} */ (house.data.gate);
  return gate?.mode ?? "remind";
}

/**
 * The org schema of the house at `root`.
 * @param {string} root
 */
export function loadOrgSchema(root) {
  return orgSchemaFrom(readHouseToml(root));
}

/**
 * @param {HouseToml} house
 * @returns {OrgSchema}
 */
export function orgSchemaFrom(house) {
  const raw = house.data.org;
  if (raw !== undefined) validate({ type: "object", properties: { org: ORG_SCHEMA_FILE.house_toml } }, { org: raw }, house.path, house.lines);
  const table = /** @type {OrgTable | undefined} */ (raw);
  return buildSchema(table?.kinds ?? {}, house.path, house.lines, {
    kindField: table?.kind_field,
    titleFallback: table?.title_fallback,
    notItems: table?.not_items,
    missingFrontmatter: table?.missing_frontmatter,
  });
}

/**
 * Merges the defaults with `extra` and checks the rules the schema subset cannot state.
 * @param {Record<string, KindTable>} extra
 * @param {string} path
 * @param {Map<string, number>} [lines]
 * @param {{ kindField?: string, titleFallback?: "heading", notItems?: string[], missingFrontmatter?: "info" | "error" }} [options]
 * @returns {OrgSchema}
 */
export function buildSchema(extra, path, lines, options = {}) {
  const kindField = options.kindField ?? "kind";
  /** @param {string[]} at @param {string} reason */
  const refuse = (at, reason) => {
    let line;
    for (let n = at.length; n > 0 && line === undefined; n--) line = lines?.get(JSON.stringify(["org", "kinds", ...at.slice(0, n)]));
    return fail("E_SCHEMA", `org.kinds.${at.join(".")} ${reason}`, { path, line });
  };
  /** @type {Map<string, Kind>} */
  const kinds = new Map();
  for (const [name, def] of Object.entries(ORG_SCHEMA_FILE.kinds)) {
    kinds.set(name, kindOf(name, def.folder, [def.folder], def.statuses, def.terminal, def.initial, def.required));
  }
  for (const [name, add] of Object.entries(extra)) {
    if (!KIND_NAME.test(name)) throw refuse([name], "is not a valid kind name: use lowercase letters, digits and hyphens, starting with a letter");
    let kind = /** @type {Kind} */ (kinds.get(name));
    if (kinds.has(name)) {
      for (const key of /** @type {const} */ (["folder", "initial", "required"])) {
        if (add[key] !== undefined) throw refuse([name, key], `cannot be set for the default kind ${name}: a house may add statuses, terminal statuses and folders, never redefine a default`);
      }
      const existing = kind;
      const added = (add.statuses ?? []).filter((status) => !existing.statuses.includes(status));
      for (const status of add.terminal ?? []) {
        if (!added.includes(status) && !existing.terminal.includes(status)) {
          throw refuse([name, "terminal"], `names ${JSON.stringify(status)}, which is not a status added by this table: a default status cannot be made terminal`);
        }
      }
      existing.statuses.push(...added);
      existing.terminal.push(...(add.terminal ?? []).filter((status) => !existing.terminal.includes(status)));
      existing.folders.push(...(add.folders ?? []).filter((folder) => !existing.folders.includes(folder)));
    } else {
      for (const key of /** @type {const} */ (["folder", "statuses", "terminal"])) {
        if (add[key] === undefined) throw refuse([name], `is a new kind and needs ${key}`);
      }
      const statuses = /** @type {string[]} */ (add.statuses);
      if (statuses.length === 0) throw refuse([name, "statuses"], "must name at least one status");
      const terminal = /** @type {string[]} */ (add.terminal);
      const unknown = terminal.find((status) => !statuses.includes(status));
      if (unknown !== undefined) throw refuse([name, "terminal"], `names ${JSON.stringify(unknown)}, which is not in statuses`);
      const initial = add.initial ?? statuses[0];
      if (!statuses.includes(initial)) throw refuse([name, "initial"], `names ${JSON.stringify(initial)}, which is not in statuses`);
      if (terminal.includes(initial)) throw refuse([name, "initial"], "cannot be a terminal status");
      const folder = /** @type {string} */ (add.folder);
      kind = kindOf(name, folder, [folder, ...(add.folders ?? []).filter((other) => other !== folder)], statuses, terminal, initial, add.required ?? DEFAULT_REQUIRED);
      kinds.set(name, kind);
    }
    if (add.kind_value !== undefined) kind.value = add.kind_value;
    if (add.nested !== undefined) kind.nested = add.nested;
    if (add.lists !== undefined) kind.lists = [...new Set(add.lists)];
    for (const [status, folder] of Object.entries(add.status_folders ?? {})) {
      if (!kind.statuses.includes(status)) throw refuse([name, "status_folders", status], `is not a ${name} status (${kind.statuses.join(", ")})`);
      kind.statusFolders.set(status, folder);
    }
    if (add.resolution_required !== undefined) kind.resolutionRequired = add.resolution_required;
    if (add.fields !== undefined) {
      for (const [field, house] of Object.entries(add.fields)) kind.fields.set(field, house);
      // Each name must read back as one field, or a write to one would be read as another.
      /** @type {Map<string, string>} */
      const taken = new Map([[kindField, "the kind field"]]);
      for (const field of FIELDS) {
        const house = fieldName(kind, field);
        const other = taken.get(house);
        if (other !== undefined) throw refuse([name, "fields", field], `names ${JSON.stringify(house)}, which is already ${other}`);
        taken.set(house, `the field for ${field}`);
      }
    }
  }
  const resolvedFolder = ORG_SCHEMA_FILE.resolved_folder;
  /** @type {Map<string, Kind>} */
  const byFolder = new Map();
  for (const kind of kinds.values()) {
    for (const folder of kind.folders) {
      const other = byFolder.get(folder);
      if (other) throw refuse([kind.name], `uses folder ${folder}, which already belongs to kind ${other.name}`);
      byFolder.set(folder, kind);
    }
  }
  // An item's place (open or resolved) is read from its path, so no folder may be another's resolved folder.
  for (const [folder, kind] of byFolder) {
    if (!folder.endsWith(`/${resolvedFolder}`)) continue;
    const owner = byFolder.get(folder.slice(0, -(resolvedFolder.length + 1)));
    if (owner) throw refuse([kind.name], `uses folder ${folder}, which is the resolved folder of kind ${owner.name}`);
  }
  // Every place belongs to one kind, so a file's kind and place are read from its path. Home and resolved folders
  // were checked above; a status folder may be any folder of its own kind but none of another's.
  /** @type {Map<string, Kind>} */
  const byPlace = new Map();
  for (const kind of kinds.values()) {
    for (const home of kind.folders) {
      for (const dir of [home, `${home}/${resolvedFolder}`]) {
        kind.places.push({ dir, home });
        byPlace.set(dir, kind);
      }
    }
  }
  for (const kind of kinds.values()) {
    /** @type {Map<string, number>} */
    const named = new Map();
    for (const dir of kind.statusFolders.values()) {
      const other = byPlace.get(dir);
      if (other && other !== kind) throw refuse([kind.name, "status_folders"], `uses folder ${dir}, which already belongs to kind ${other.name}`);
      if (!other) {
        kind.places.push({ dir, home: kind.folder });
        byPlace.set(dir, kind);
      }
      named.set(dir, (named.get(dir) ?? 0) + 1);
    }
    for (const [status, dir] of kind.statusFolders) if (named.get(dir) === 1) kind.implied.set(dir, status);
  }
  return {
    kinds,
    byFolder,
    byPlace,
    resolvedFolder,
    resolvedFields: [...ORG_SCHEMA_FILE.resolved_fields],
    kindField,
    titleFallback: options.titleFallback ?? null,
    notItems: (options.notItems ?? []).map(globRegExp),
    missingFrontmatter: options.missingFrontmatter ?? "info",
  };
}

/**
 * @param {string} name
 * @param {string} folder
 * @param {string[]} folders
 * @param {string[]} statuses
 * @param {string[]} terminal
 * @param {string} initial
 * @param {readonly string[]} required
 * @returns {Kind}
 */
function kindOf(name, folder, folders, statuses, terminal, initial, required) {
  return {
    name,
    value: name,
    folder,
    folders,
    statuses: [...new Set(statuses)],
    terminal: [...new Set(terminal)],
    initial,
    required: [...new Set(required)],
    nested: false,
    statusFolders: new Map(),
    implied: new Map(),
    lists: [],
    fields: new Map(),
    resolutionRequired: true,
    places: [],
  };
}

/**
 * The folder an item of `kind` with `status` belongs in: the status's own folder, else its home folder while open
 * and the home's resolved folder once terminal.
 * @param {OrgSchema} schema
 * @param {Kind} kind
 * @param {string} home
 * @param {string} status
 */
export function placeFor(schema, kind, home, status) {
  return kind.statusFolders.get(status) ?? (isTerminal(kind, status) ? `${home}/${schema.resolvedFolder}` : home);
}

/** @param {Kind} kind @param {string} status */
export function isTerminal(kind, status) {
  return kind.terminal.includes(status);
}

/**
 * The name items of `kind` give the field lampstand calls `field`; a field the kind does not rename keeps its name.
 * @param {Kind} kind
 * @param {string} field
 */
export function fieldName(kind, field) {
  return kind.fields.get(field) ?? field;
}

/**
 * A glob over house-relative paths as an anchored expression: `*` is any run within one folder name, `?` one
 * character other than `/`, a `**` segment any number of folders (none included); everything else is literal.
 * @param {string} glob
 */
export function globRegExp(glob) {
  const parts = glob.split("/");
  let source = "";
  for (let k = 0; k < parts.length; k++) {
    const last = k === parts.length - 1;
    if (parts[k] === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    source += parts[k].replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    if (!last) source += "/";
  }
  return new RegExp(`^${source}$`);
}
