// @ts-check
// Links across the house: [[wikilinks]] and inline Markdown links `[text](dest)`, resolved by one rule.
// - A target that starts with `./` or `../` is relative to the folder of the file that holds the link. It names the
//   file at exactly that path (a trailing `.md` optional) or a folder there; one that climbs above the house root
//   names nothing.
// - Any other target is read from the house root. With a `/` it is a house-relative path (a leading `/` ignored, a
//   trailing `.md` optional; a suffix of a path also resolves, as note tools allow); without one it is a file name,
//   matched against every file's name and every Markdown file's stem.
// - Matching ignores case, since the house is checked out on case-insensitive filesystems too and a link that opens
//   there must not be called dangling.
// - A target that names something outside the house's files is never resolved: a wikilink target that starts with a
//   URL scheme (`skill://x`, `agent://y`), a Markdown destination that starts with any scheme (`https:`, `mailto:`)
//   or with `//`.
// - A Markdown destination is read percent-decoded and without its `?query` and `#fragment`; an empty target
//   (`[[#heading]]`, `(#heading)`) is the file itself.
import { existsSync, readdirSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail } from "../errors.js";
import { atomicWrite, errorMessage, readText } from "../io.js";
import { findLinks, rewriteLinks } from "./markdown.js";

/** @typedef {import("./markdown.js").Link} Link */
/**
 * @typedef {{
 *   files: string[],
 *   byPath: Map<string, string>,
 *   byName: Map<string, string[]>,
 *   dirs: Set<string>,
 * }} HouseIndex
 *   `byName` is keyed by lowercased file name and, for Markdown files, also by lowercased stem; `dirs` holds every
 *   folder that contains a file, lowercased.
 */

/** Directories never searched: git's own store and installed dependencies. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Every regular file in the house, house-relative with `/`.
 * @param {string} root
 * @returns {string[]}
 */
export function walkHouse(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const visit = (rel) => {
    let entries;
    try {
      entries = readdirSync(rel === "" ? root : join(root, ...rel.split("/")), { withFileTypes: true });
    } catch (cause) {
      throw fail("E_IO", `cannot list: ${errorMessage(cause)}`, { path: join(root, rel), cause });
    }
    for (const entry of entries) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  };
  visit("");
  return out.sort();
}

/** @param {string} rel */
function baseName(rel) {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

/** @param {string} rel */
function stemOf(rel) {
  const name = baseName(rel);
  return /\.md$/i.test(name) ? name.slice(0, -3) : name;
}

/**
 * @param {string[]} files
 * @returns {HouseIndex}
 */
export function indexFiles(files) {
  /** @type {Map<string, string>} */
  const byPath = new Map();
  /** @type {Map<string, string[]>} */
  const byName = new Map();
  /** @param {string} key @param {string} rel */
  const add = (key, rel) => {
    const list = byName.get(key);
    if (list) {
      if (!list.includes(rel)) list.push(rel);
    } else byName.set(key, [rel]);
  };
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const rel of files) {
    byPath.set(rel.toLowerCase(), rel);
    add(baseName(rel).toLowerCase(), rel);
    if (/\.md$/i.test(rel)) add(stemOf(rel).toLowerCase(), rel);
    for (let dir = folderOf(rel); dir !== "" && !dirs.has(dir.toLowerCase()); dir = folderOf(dir)) dirs.add(dir.toLowerCase());
  }
  return { files, byPath, byName, dirs };
}

/** The house-relative folder of `rel`, `""` at the root. @param {string} rel */
function folderOf(rel) {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

/** True for a target relative to the linking file: `.`, `..`, or one starting `./` or `../`. @param {string} target */
export function isRelativeTarget(target) {
  return /^\.\.?(?:\/|$)/.test(target.trim());
}

/**
 * The house-relative path a relative `target` names from `folder`, without a trailing `/`; null when it climbs above
 * the house root.
 * @param {string} folder
 * @param {string} target
 */
function joinRelative(folder, target) {
  const out = folder === "" ? [] : folder.split("/");
  for (const part of target.trim().split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * A target relative to `folder` naming the house path `to`, always starting `./` or `../` so it reads back as
 * relative.
 * @param {string} folder
 * @param {string} to
 */
function relativeTarget(folder, to) {
  const from = folder === "" ? [] : folder.split("/");
  const parts = to === "" ? [] : to.split("/");
  let common = 0;
  while (common < from.length && common < parts.length && from[common].toLowerCase() === parts[common].toLowerCase()) common++;
  const up = from.length - common;
  const down = parts.slice(common).join("/");
  if (up === 0) return down === "" ? "." : `./${down}`;
  return [...Array(up).fill(".."), ...(down === "" ? [] : [down])].join("/");
}

/** A link target as written, without surrounding blanks or a leading `/`. @param {string} target */
export function normalizeTarget(target) {
  return target.trim().replace(/^\//, "");
}

/** True for a target that opens with a URL scheme (`name://`), which names no file. @param {string} target */
export function isSchemeTarget(target) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(target.trim());
}

/** True for a link that names something outside the house's files. @param {Link} link */
export function isExternalLink(link) {
  if (link.syntax === "wiki") return isSchemeTarget(link.target);
  return /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(link.target.trim());
}

/**
 * The files a link target resolves to: empty when it dangles. An empty target (`[[#heading]]`) is the file itself.
 * @param {HouseIndex} index
 * @param {string} target
 * @param {string} from  the house-relative path of the file that holds the link
 * @returns {string[]}
 */
export function resolveTarget(index, target, from) {
  if (isRelativeTarget(target)) {
    const path = joinRelative(folderOf(from), target);
    if (path === null) return [];
    const lower = path.toLowerCase();
    const file = index.byPath.get(lower) ?? index.byPath.get(`${lower}.md`);
    if (file) return [file];
    return lower === "" ? ["./"] : index.dirs.has(lower) ? [`${path}/`] : [];
  }
  const t = normalizeTarget(target).toLowerCase();
  if (t === "") return ["(self)"];
  if (!t.includes("/")) return index.byName.get(t) ?? [];
  const exact = index.byPath.get(t) ?? index.byPath.get(`${t}.md`);
  if (exact) return [exact];
  return index.files.filter((rel) => {
    const lower = rel.toLowerCase();
    return lower.endsWith(`/${t}`) || lower.endsWith(`/${t}.md`);
  });
}

/**
 * Markdown files whose links relink rewrites: generated projections are rebuilt by the compiler, never edited.
 * @param {string} rel
 */
function rewritable(rel) {
  return /\.md$/i.test(rel) && !rel.startsWith(".house/");
}

/**
 * Rewrites every link that pointed at `oldRel` so it points at `newRel`, across the house. Call it after the file
 * has moved. A relative link stays relative: it is rewritten from its own file's folder, and the moved file's own
 * relative links are rewritten from its new folder so they still name what they named. A path-form link becomes the
 * new house-relative path; a name-form link becomes the new name when the name changed and the old name no longer
 * names any other file (otherwise it may mean that other file and is left). Links outside the house are never
 * touched.
 * @param {string} root
 * @param {string} oldRel
 * @param {string} newRel
 * @returns {{ path: string, links: number }[]}
 */
export function relinkHouse(root, oldRel, newRel) {
  const files = walkHouse(root);
  const index = indexFiles(files);
  const oldMd = /\.md$/i.test(oldRel);
  const oldNoExt = oldMd ? oldRel.slice(0, -3) : oldRel;
  const newNoExt = /\.md$/i.test(newRel) ? newRel.slice(0, -3) : newRel;
  const oldName = baseName(oldRel).toLowerCase();
  const oldStem = stemOf(oldRel).toLowerCase();
  /** True when no file other than the moved one answers to `key`, so a link by that name meant the moved file. */
  const onlyMoved = (/** @type {string} */ key) => (index.byName.get(key) ?? []).every((rel) => rel === newRel);
  /** The new name when it alone names the moved file; otherwise its full path, so the link cannot become ambiguous. */
  const nameOrPath = (/** @type {string} */ name, /** @type {string} */ path) => (onlyMoved(name.toLowerCase()) ? name : path);

  /** @param {Link} link @param {string} rel  the file holding the link @returns {string | null} */
  const retarget = (link, rel) => {
    if (isExternalLink(link)) return null;
    const written = link.target.trim();
    if (isRelativeTarget(written)) {
      // The moved file's links were written from its old folder.
      const path = joinRelative(folderOf(rel === newRel ? oldRel : rel), written);
      if (path === null) return null;
      const lower = path.toLowerCase();
      const meant = lower === oldRel.toLowerCase()
        ? newRel
        : oldMd && lower === oldNoExt.toLowerCase()
          ? newNoExt
          : rel === newRel ? path : null;
      if (meant === null) return null;
      const next = `${relativeTarget(folderOf(rel), meant)}${written.endsWith("/") && meant !== "" ? "/" : ""}`;
      return next === written ? null : next;
    }
    const lower = normalizeTarget(written).toLowerCase();
    if (lower === "") return null;
    if (lower.includes("/")) {
      const matches = (/** @type {string} */ full) => full === lower || full.endsWith(`/${lower}`);
      if (matches(oldRel.toLowerCase())) return newRel;
      if (oldMd && matches(oldNoExt.toLowerCase())) return newNoExt;
      return null;
    }
    if (lower === oldName && baseName(newRel).toLowerCase() !== oldName && onlyMoved(oldName)) {
      return nameOrPath(baseName(newRel), newRel);
    }
    if (oldMd && lower === oldStem && stemOf(newRel).toLowerCase() !== oldStem && onlyMoved(oldStem)) {
      return nameOrPath(stemOf(newRel), newNoExt);
    }
    return null;
  };

  /** @type {{ path: string, links: number }[]} */
  const changed = [];
  for (const rel of files) {
    if (!rewritable(rel)) continue;
    const full = join(root, ...rel.split("/"));
    const text = readText(full);
    if (!text.includes("[[") && !text.includes("](")) continue;
    const edits = [];
    for (const link of findLinks(text)) {
      const target = retarget(link, rel);
      if (target !== null) edits.push({ link, target });
    }
    if (edits.length === 0) continue;
    atomicWrite(full, rewriteLinks(text, edits));
    changed.push({ path: rel, links: edits.length });
  }
  return changed;
}

/**
 * Moves a house file from `oldRel` to `newRel` (creating parents; refusing to replace an existing file) and rewrites
 * the links that pointed at it.
 * @param {string} root
 * @param {string} oldRel
 * @param {string} newRel
 */
export function moveAndRelink(root, oldRel, newRel) {
  const from = join(root, ...oldRel.split("/"));
  const to = join(root, ...newRel.split("/"));
  if (existsSync(to)) throw fail("E_IO", `cannot move ${oldRel}: ${newRel} already exists`, { path: to });
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch (cause) {
    throw fail("E_IO", `cannot move to ${newRel}: ${errorMessage(cause)}`, { path: from, cause });
  }
  return relinkHouse(root, oldRel, newRel);
}
