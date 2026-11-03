// @ts-check
// Update proposals: what `lampstand upgrade` writes to proposals/updates/ when a planted file changed upstream and the
// operator's copy must not be replaced (an edited file, or the lattice, which is never replaced). Each carries the
// whole new text in a fenced block and, in its frontmatter, what it was written against (see upgrade.js). `adopt`
// lists them as `update/<target path>` beside the other proposals; adopting writes the text to the target, keeping a
// principle file's provenance the way principle adoption does, and striking declines it for good (the strike is
// recorded, and upgrade does not offer the same text again).
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "../frontmatter.js";
import { atomicWrite, contentHash, readText } from "../io.js";
import { chars } from "./budgets.js";
import { LATTICE_FILE, PLANTED_FILE, UPDATES_DIR, plantedHash, readPlanted, writePlanted } from "../init/plant.js";
import { actPaths, adoptItem, appendRecord, listProposals, RECORD_PATH, renderFrontmatter, strikeItem, surfaceMeter } from "./curate.js";
import { loadHouse } from "./house.js";
import { parsePrincipleText } from "./parse.js";

/** @typedef {import("./curate.js").ProposedItem} ProposedItem */

/** @param {string} root @param {string} rel */
function full(root, rel) {
  return join(root, ...rel.split("/"));
}

/** The budget surface a target file's text lands in; empty when none measures it. @param {string} target */
function surfaceFor(target) {
  if (target.startsWith("principles/")) return "principle-detail";
  if (target.startsWith("charter/")) return "charter-core";
  if (target.startsWith("reflexes/")) return "reflex-index";
  if (target === "voice.md") return "voice";
  return "";
}

/** A house-relative path that stays inside the house and out of .git. @param {string} rel */
function safeTarget(rel) {
  const segments = rel.split("/");
  return !rel.startsWith("/") && !rel.includes("\\") && segments.every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}

/** @param {string} root @param {string} dir house-relative @returns {string[]} */
function markdownUnder(root, dir) {
  const base = full(root, dir);
  if (!existsSync(base)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...markdownUnder(root, rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

/** @param {unknown} value @returns {string | null} */
const text = (value) => (typeof value === "string" && value !== "" ? value : null);

/**
 * Every update proposal in the house, in code point order of its target, as items of kind `update`.
 * @param {string} root
 * @returns {ProposedItem[]}
 */
export function listUpdates(root) {
  const paths = markdownUnder(root, UPDATES_DIR);
  if (paths.length === 0) return [];
  const { current, capFor } = surfaceMeter(loadHouse(root));
  /** @type {ProposedItem[]} */
  const items = [];
  for (const path of paths) {
    const raw = readText(full(root, path));
    const parsed = parseFrontmatter(raw, full(root, path));
    const target = text(parsed.frontmatter?.updates);
    if (target === null) continue;
    const surface = surfaceFor(target);
    const upstream = text(parsed.frontmatter?.["upstream-sha256"]);
    items.push({
      id: `update/${target}`,
      kind: "update",
      slug: target,
      path,
      text: raw,
      body: parsed.body,
      hash: upstream ?? contentHash(parsed.body),
      occasion: null,
      chars: chars(raw),
      surface,
      surfaceChars: surface === "" ? 0 : current(surface),
      cap: surface === "" ? 0 : capFor(surface),
      update: {
        target,
        upstream,
        textSha: text(parsed.frontmatter?.["text-sha256"]),
        targetSha: text(parsed.frontmatter?.["target-sha256"]),
        planted: text(parsed.frontmatter?.["planted-sha256"]),
      },
    });
  }
  return items.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
}

/**
 * Every proposal the operator can act on: principles, provisions and reflexes, then updates to planted files.
 * @param {string} root
 * @returns {ProposedItem[]}
 */
export function listAllProposals(root) {
  return [...listProposals(root), ...listUpdates(root)];
}

/**
 * The new text an update proposal carries: the first fenced block of its body, or null for a note that proposes none.
 * @param {string} body
 * @returns {string[] | null}  the block's lines
 */
function fencedLines(body) {
  const lines = body.split("\n");
  const open = lines.findIndex((line) => /^`{3,}$/.test(line));
  if (open < 0) return null;
  const close = lines.indexOf(lines[open], open + 1);
  return close < 0 ? null : lines.slice(open + 1, close);
}

/**
 * Takes an update proposal: writes its text over the target and records the act. Returns a refusal reason instead
 * when the proposal carries no text, the text does not match its recorded hash, the target changed since the
 * proposal was written, or the result would not parse.
 * @param {string} root
 * @param {ProposedItem} item
 * @param {string} date
 * @returns {string | null}
 */
export function adoptUpdate(root, item, date) {
  const offer = /** @type {NonNullable<ProposedItem["update"]>} */ (item.update);
  const target = offer.target;
  if (!safeTarget(target)) return `${item.path} names ${JSON.stringify(target)}, which is not a file inside the house`;
  const lines = fencedLines(parseFrontmatter(item.text, item.path).body);
  if (lines === null) return `${item.id} proposes no text, only a note: compare it with ${target} by hand, then strike it`;
  const body = lines.join("\n");
  const wanted = offer.textSha ?? offer.upstream;
  const newText = [`${body}\n`, body].find((candidate) => contentHash(candidate) === wanted);
  if (newText === undefined) return `${item.path} does not match the hash it records for its text; strike it and run lampstand upgrade again`;

  const targetPath = full(root, target);
  if (!existsSync(targetPath)) return `${target} no longer exists, so there is nothing to update; strike this proposal`;
  const here = readText(targetPath);
  if (offer.targetSha !== null) {
    if (plantedHash(target, here) !== offer.targetSha) {
      return `${target} changed after this update was proposed, so it is not overwritten: strike this proposal (lampstand upgrade offers the lattice again; take what you want from any other file by hand)`;
    }
  } else if (target === LATTICE_FILE && offer.planted !== null) {
    if (contentHash(parseFrontmatter(here, targetPath).body) !== offer.planted) return `${target} was edited after this update was proposed, so it is not overwritten: strike this proposal`;
  } else {
    return `${item.path} was written by an older lampstand that did not record the file it was written against, so it cannot be checked: take what you want by hand, then strike it`;
  }

  let out = newText;
  if (target.startsWith("principles/")) {
    // As principle adoption does: the file keeps its origin, is dated today, and carries the hash of its new body.
    const parsed = parseFrontmatter(newText, targetPath);
    out = `${renderFrontmatter({ ...(parsed.frontmatter ?? { origin: "own" }), adopted: date, "adopted-hash": contentHash(parsed.body) })}${parsed.body}`;
    try {
      parsePrincipleText(out, targetPath, "adopted");
    } catch (error) {
      return `${item.id} would not parse as a principle file: ${/** @type {Error} */ (error).message}`;
    }
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  atomicWrite(targetPath, out);
  // planted.json holds what lampstand last planted: the new text, so the next upgrade sees the file as unedited.
  const planted = readPlanted(root);
  if (planted.files[target] !== undefined) {
    planted.files[target].sha256 = plantedHash(target, out);
    writePlanted(root, planted);
  }
  appendRecord(root, { date, act: "adopted", kind: "update", slug: target, hash: item.hash });
  rmSync(full(root, item.path), { force: true });
  return null;
}

/**
 * Declines an update proposal: records the offer's hash, so upgrade does not make the same offer again, and removes it.
 * @param {string} root
 * @param {ProposedItem} item
 * @param {string} date
 */
export function strikeUpdate(root, item, date) {
  appendRecord(root, { date, act: "struck", kind: "update", slug: /** @type {NonNullable<ProposedItem["update"]>} */ (item.update).target, hash: item.hash });
  rmSync(full(root, item.path), { force: true });
}

/**
 * The house-relative paths an act on an update writes, moves or deletes.
 * @param {ProposedItem} item
 * @param {"adopted" | "struck"} act
 */
export function updatePaths(item, act) {
  const target = /** @type {NonNullable<ProposedItem["update"]>} */ (item.update).target;
  return act === "adopted" ? [RECORD_PATH, item.path, target, PLANTED_FILE] : [RECORD_PATH, item.path];
}

/**
 * Adopts any listed item: an update by writing its text over its target, anything else into the constitution.
 * @param {string} root @param {ProposedItem} item @param {string} date
 * @returns {string | null}  a refusal reason, or null when adopted
 */
export function adoptAny(root, item, date) {
  return item.kind === "update" ? adoptUpdate(root, item, date) : adoptItem(root, item, date);
}

/** Strikes any listed item. @param {string} root @param {ProposedItem} item @param {string} date */
export function strikeAny(root, item, date) {
  if (item.kind === "update") strikeUpdate(root, item, date);
  else strikeItem(root, item, date);
}

/** The paths an act on any listed item writes. @param {ProposedItem} item @param {"adopted" | "struck"} act */
export function actPathsAny(item, act) {
  return item.kind === "update" ? updatePaths(item, act) : actPaths(item, act);
}
