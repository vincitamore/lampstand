// @ts-check
// Org items on disk. An item lives in one of its kind's places: a home folder while open, `<folder>/resolved/` once
// terminal, or the folder its status names in house.toml; a nested kind also reads its places' subfolders. Its
// identity is its file stem. Every write goes through here so the lifecycle invariant (status <=> place, with the
// resolved date and, where the kind requires one, the resolution set on a terminal item) holds after each act.
// Fields are read and written under the names the kind's items give them.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fail, isLampstandError } from "../errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import { atomicWrite, errorMessage, readText } from "../io.js";
import { moveAndRelink } from "./links.js";
import { editFrontmatter, isDate, maskCode, renderItem, slugify, utcDate } from "./markdown.js";
import { fieldName, isTerminal, placeFor, UNLANDED_STATUSES } from "./schema.js";

/** @typedef {import("./schema.js").Kind} Kind */
/** @typedef {import("./schema.js").Field} Field */
/** @typedef {import("./schema.js").OrgSchema} OrgSchema */
/** @typedef {import("../frontmatter.js").Frontmatter} Frontmatter */
/** @typedef {import("../errors.js").LampstandError} LampstandError */
/**
 * @typedef {{
 *   rel: string,
 *   kind: Kind,
 *   folder: string,
 *   place: string,
 *   text: string,
 *   frontmatter: Frontmatter | null,
 *   body: string,
 *   error: LampstandError | null,
 * }} ItemFile
 *   One Markdown file found in a kind's places. `folder` is the home folder whose item it is; `place` is the folder
 *   of the kind it was found in (the file may sit in a subfolder of it when the kind is nested). `frontmatter` is
 *   null when the file has none or does not parse (then `error` says why).
 * @typedef {{ rel: string, text: string }} NoteFile
 *   A Markdown file in a kind's places that house.toml names as not an item.
 */

const TEMPLATES = new URL("../../../templates/org/", import.meta.url);
/** Directories a nested walk never enters: git's own store and installed dependencies. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** @param {string} root @param {string} rel */
export function fullPath(root, rel) {
  return join(root, ...rel.split("/"));
}

/**
 * Markdown files under `dirRel`, house-relative and sorted: those directly in it, and when `nested` those in its
 * subfolders too, except subfolders in `stop` (folders read in their own right). Empty when it does not exist.
 * @param {string} root
 * @param {string} dirRel
 * @param {boolean} nested
 * @param {Map<string, unknown>} stop
 * @returns {string[]}
 */
function markdownFiles(root, dirRel, nested, stop) {
  let entries;
  try {
    entries = readdirSync(fullPath(root, dirRel), { withFileTypes: true });
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code === "ENOENT") return [];
    throw fail("E_IO", `cannot list: ${errorMessage(cause)}`, { path: fullPath(root, dirRel), cause });
  }
  const names = entries.map((entry) => entry.name).sort();
  const files = names.filter((name) => name.endsWith(".md") && entries.find((entry) => entry.name === name)?.isFile()).map((name) => `${dirRel}/${name}`);
  if (!nested) return files;
  for (const name of names) {
    const child = `${dirRel}/${name}`;
    if (SKIP_DIRS.has(name) || stop.has(child) || !entries.find((entry) => entry.name === name)?.isDirectory()) continue;
    files.push(...markdownFiles(root, child, true, stop));
  }
  return files;
}

/**
 * Every Markdown file in every kind's places: the items, parsed, and the files house.toml names as not items. A file
 * that does not parse is returned with its error rather than aborting the scan, so one bad file never hides the rest.
 * @param {string} root
 * @param {OrgSchema} schema
 * @returns {{ items: ItemFile[], notes: NoteFile[] }}
 */
export function scanOrg(root, schema) {
  /** @type {ItemFile[]} */
  const items = [];
  /** @type {NoteFile[]} */
  const notes = [];
  for (const kind of schema.kinds.values()) {
    for (const place of kind.places) {
      for (const rel of markdownFiles(root, place.dir, kind.nested, schema.byPlace)) {
        if (schema.notItems.some((glob) => glob.test(rel))) notes.push({ rel, text: readText(fullPath(root, rel)) });
        else items.push(readItem(root, rel, kind, place.home, place.dir));
      }
    }
  }
  return { items, notes };
}

/**
 * Every item in every kind's places, parsed; see scanOrg.
 * @param {string} root
 * @param {OrgSchema} schema
 */
export function scanItems(root, schema) {
  return scanOrg(root, schema).items;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {Kind} kind
 * @param {string} folder
 * @param {string} place
 * @returns {ItemFile}
 */
function readItem(root, rel, kind, folder, place) {
  const text = readText(fullPath(root, rel));
  try {
    const parsed = parseFrontmatter(text, rel);
    return { rel, kind, folder, place, text, frontmatter: parsed.frontmatter, body: parsed.body, error: null };
  } catch (error) {
    if (!isLampstandError(error)) throw error;
    return { rel, kind, folder, place, text, frontmatter: null, body: "", error };
  }
}

/**
 * The status an item has: its status field; else the status its folder implies; else the kind's initial status
 * when the kind does not require one. Undefined when it cannot be told.
 * @param {ItemFile} item
 */
export function statusOf(item) {
  const value = item.frontmatter?.[fieldName(item.kind, "status")];
  if (typeof value === "string") return value;
  if (value !== undefined || !item.frontmatter) return undefined;
  return item.kind.implied.get(item.place) ?? (item.kind.required.includes("status") ? undefined : item.kind.initial);
}

/**
 * An item's title: its title field, or, when the field is absent and the house reads titles from headings, the
 * text of the body's first level-1 heading outside code. Undefined when it has neither.
 * @param {ItemFile} item
 * @param {OrgSchema} schema
 */
export function titleOf(item, schema) {
  const value = item.frontmatter?.[fieldName(item.kind, "title")];
  if (typeof value === "string" && value !== "") return value;
  if (value !== undefined) return undefined;
  if (schema.titleFallback !== "heading" || !item.frontmatter) return undefined;
  const heading = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/m.exec(maskCode(item.body));
  return heading && heading[1] !== "" ? heading[1] : undefined;
}

/** @param {ItemFile} item */
export function stemOfItem(item) {
  return item.rel.slice(item.rel.lastIndexOf("/") + 1, -3);
}

/** Edit distance between two short strings. @param {string} a @param {string} b */
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/**
 * The one item of `items` that `ref` names: a file stem, a file name or a house-relative path; failing that, a title
 * (case-insensitive, whitespace-collapsed) or text that slugifies to a stem. A ref that names nothing gets the closest
 * stems in the message; one that names several lists them.
 * @param {ItemFile[]} items
 * @param {string} ref
 * @param {string} what  how the caller names the kinds, for messages
 * @param {OrgSchema} schema  reads each item's title
 */
export function findItem(items, ref, what, schema) {
  const wanted = ref.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "").toLowerCase();
  const exact = items.filter((item) => {
    const rel = item.rel.slice(0, -3).toLowerCase();
    return wanted.includes("/") ? rel === wanted : stemOfItem(item).toLowerCase() === wanted;
  });
  if (exact.length > 1) {
    throw fail("E_USAGE", `${JSON.stringify(ref)} names more than one ${what}: ${exact.map((item) => item.rel).join(", ")}; give the path`);
  }
  if (exact.length === 1) return exact[0];

  const title = ref.trim().replace(/\s+/g, " ").toLowerCase();
  const slug = slugify(ref);
  const named = items.filter((item) => {
    const own = titleOf(item, schema);
    return (own !== undefined && own.trim().replace(/\s+/g, " ").toLowerCase() === title) || (slug !== "" && stemOfItem(item).toLowerCase() === slug);
  });
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw fail("E_USAGE", `${JSON.stringify(ref)} names more than one ${what}: ${named.map((item) => item.rel).join(", ")}; give the path`);
  }
  const target = slug === "" ? wanted : slug;
  const limit = Math.max(3, Math.ceil(target.length * 0.4));
  const close = [...new Set(items.map(stemOfItem))]
    .map((stem) => ({ stem, score: distance(target, stem.toLowerCase()) }))
    .filter(({ score }) => score <= limit)
    .sort((a, b) => a.score - b.score || (a.stem < b.stem ? -1 : 1))
    .slice(0, 3)
    .map(({ stem }) => stem);
  const hint = close.length === 0 ? "" : `; did you mean ${close.join(", ")}?`;
  throw fail("E_USAGE", `no ${what} named ${JSON.stringify(ref)}${hint}`);
}

/**
 * A free file name `<stem>.md` in every folder of `dirs` (the places of the item's kind), so neither the new file
 * nor a later lifecycle move shares a stem with another item of the kind.
 * @param {string} root
 * @param {string[]} dirs
 * @param {string} stem
 */
function freeStem(root, dirs, stem) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    if (dirs.every((dir) => !existsSync(fullPath(root, `${dir}/${candidate}.md`)))) return candidate;
  }
}

/** The body template for `name` with `{{key}}` placeholders filled. @param {string} name @param {Record<string, string>} values */
export function fillTemplate(name, values) {
  const text = readFileSync(new URL(`${name}.md`, TEMPLATES), "utf8").replaceAll("\r\n", "\n");
  return text.replace(/\{\{([a-z_]+)\}\}/g, (whole, key) => (Object.hasOwn(values, key) ? values[key] : whole));
}

/**
 * Writes a new item of `kind` into the folder of its initial status.
 * @param {string} root
 * @param {OrgSchema} schema
 * @param {Kind} kind
 * @param {{ title: string, fields?: Partial<Record<Field, string>>, body?: string, stem?: string, now?: Date }} input
 * @returns {string} the new file's house-relative path
 */
export function createItem(root, schema, kind, input) {
  const title = input.title.trim();
  if (title === "" || title.includes("\n")) throw fail("E_USAGE", "a title is one non-empty line");
  const now = input.now ?? new Date();
  const dir = placeFor(schema, kind, kind.folder, kind.initial);
  const stem = freeStem(root, kind.places.map((place) => place.dir), input.stem ?? (slugify(title) || kind.name));
  const rel = `${dir}/${stem}.md`;
  /** @type {Record<string, string>} */
  const fields = { [schema.kindField]: kind.value };
  for (const [field, value] of Object.entries({ title, status: kind.initial, created: utcDate(now), ...input.fields })) {
    fields[fieldName(kind, field)] = value;
  }
  const extra = input.body === undefined || input.body.trim() === "" ? "" : `\n${input.body.trim()}\n`;
  const template = existsSync(new URL(`${kind.name}.md`, TEMPLATES)) ? kind.name : "item";
  const body = fillTemplate(template, { title, body: extra });
  mkdirSync(fullPath(root, dir), { recursive: true });
  const full = fullPath(root, rel);
  atomicWrite(full, renderItem(fields, body));
  return rel;
}

/**
 * Checks a resolution: one line. For a status that means the work landed it names where, by a [[wikilink]] or a URL;
 * for one that means it landed nowhere (dropped, withdrawn, abandoned) it is a plain reason.
 * @param {string | undefined} resolution
 * @param {string} status  the terminal status being set
 */
export function checkResolution(resolution, status) {
  const unlanded = UNLANDED_STATUSES.includes(status);
  if (resolution === undefined || resolution.trim() === "") {
    throw fail(
      "E_USAGE",
      unlanded ? `${status} needs --resolution "<one line reason>"` : `a terminal status needs --resolution "<one line>" naming where the work landed ([[link]] or URL)`,
    );
  }
  if (/[\r\n]/.test(resolution)) throw fail("E_USAGE", "--resolution is one line");
  if (!unlanded && !/\[\[[^\[\]\n]+\]\]|\bhttps?:\/\/\S+/.test(resolution)) {
    throw fail("E_USAGE", `--resolution must name where the work landed with a [[wikilink]] or a URL (only ${UNLANDED_STATUSES.join(", ")} take a plain reason)`);
  }
  return resolution.trim();
}

/**
 * @typedef {{
 *   from: string,
 *   to: string,
 *   status: string,
 *   relinked: { path: string, links: number }[],
 * }} Transition
 */

/**
 * Moves an item to `status`, enforcing the lifecycle in one act: a terminal status sets `resolved` (today, UTC) and
 * `resolution` (which a kind that does not require one may go without), a non-terminal one clears both, and the file
 * moves to the folder its new status belongs in (keeping its subfolder within a nested kind's place). Every link to
 * the old path is rewritten. Other fields in `fields` are set alongside.
 * @param {string} root
 * @param {OrgSchema} schema
 * @param {ItemFile} item
 * @param {{ status?: string, resolution?: string, fields?: Partial<Record<Field, string>>, now?: Date }} change
 * @returns {Transition}
 */
export function transition(root, schema, item, change) {
  if (item.error || !item.frontmatter) {
    throw item.error ?? fail("E_PARSE_FRONTMATTER", "the item has no frontmatter", { path: item.rel, line: 1 });
  }
  const status = change.status ?? statusOf(item) ?? item.kind.initial;
  if (!item.kind.statuses.includes(status)) {
    throw fail("E_USAGE", `${JSON.stringify(status)} is not a ${item.kind.name} status; use one of ${item.kind.statuses.join(", ")}`);
  }
  const kind = item.kind;
  const terminal = isTerminal(kind, status);
  /** @type {Record<string, string | null>} */
  const edits = {};
  for (const [field, value] of Object.entries({ ...change.fields, status })) edits[fieldName(kind, field)] = value;
  const [resolvedKey, resolutionKey] = schema.resolvedFields.map((field) => fieldName(kind, field));
  if (terminal) {
    const before = statusOf(item);
    const wasTerminal = before !== undefined && isTerminal(kind, before) && item.place === placeFor(schema, kind, item.folder, before);
    if (change.resolution !== undefined || !wasTerminal) {
      edits[resolvedKey] = utcDate(change.now);
      if (change.resolution !== undefined || kind.resolutionRequired) edits[resolutionKey] = checkResolution(change.resolution, status);
    }
  } else {
    if (change.resolution !== undefined) throw fail("E_USAGE", `--resolution applies only to a terminal status (${kind.terminal.join(", ")})`);
    edits[resolvedKey] = null;
    edits[resolutionKey] = null;
  }
  const updated = editFrontmatter(item.text, edits, item.rel);
  atomicWrite(fullPath(root, item.rel), updated);

  const cut = item.rel.lastIndexOf("/");
  const name = item.rel.slice(cut + 1);
  const sub = item.rel.slice(item.place.length, cut);
  const target = placeFor(schema, kind, item.folder, status);
  if (target === item.place) return { from: item.rel, to: item.rel, status, relinked: [] };
  const targetDir = `${target}${sub}`;
  const stem = freeStem(root, [targetDir], name.slice(0, -3));
  const to = `${targetDir}/${stem}.md`;
  const relinked = moveAndRelink(root, item.rel, to);
  return { from: item.rel, to, status, relinked };
}

/** @param {string} value @param {string} flag */
export function checkDate(value, flag) {
  if (!isDate(value)) throw fail("E_USAGE", `--${flag} must be a date YYYY-MM-DD, got ${JSON.stringify(value)}`);
  return value;
}
