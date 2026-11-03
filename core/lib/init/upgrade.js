// @ts-check
// `lampstand upgrade` migrates a house to what this lampstand plants; the plugin's own code is upgraded by the
// host. In order: refuse a house newer than this code, back up house.toml and .house/ into the per-machine state
// dir, apply the forward migrations, bring planted files up to date, recompile and rewrite the AGENTS.md region.
//
// A planted file whose template changed is replaced only when the operator never edited it (its hash still equals
// planted.json's); an edited one keeps every byte and gets a proposal in proposals/updates/ instead. The lattice is
// never replaced: an unedited copy gets the new pack text as a proposal, an edited one a note that the pack changed.
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail } from "../errors.js";
import { atomicWrite, contentHash, readText } from "../io.js";
import { HOUSE_SCHEMA_VERSION, loadHouseConfig } from "../config.js";
import { parseFrontmatter } from "../frontmatter.js";
import { renderFrontmatter } from "../constitution/curate.js";
import { runCompile } from "../constitution/run.js";
import { stateDirFor } from "../state/paths.js";
import {
  fullPath,
  LATTICE_FILE,
  LATTICE_PACK,
  latticeFile,
  plantedHash,
  readPlanted,
  templateFiles,
  UPDATES_DIR,
  VERSION,
  writePlanted,
} from "./plant.js";
import { AGENTS_FILE, writeAgentsRegion } from "./region.js";

/** @typedef {import("../constitution/rules.js").Finding} Finding */
/**
 * One forward step of house.toml's schema. `run` rewrites what the step changes and returns the house-relative
 * paths it wrote.
 * @typedef {{ from: number, to: number, summary: string, run: (root: string) => string[] }} Migration
 */

/**
 * Every migration, in the order they apply; each takes a house from schema `from` to `from + 1`. Empty while
 * house.schema 1 is the only schema there has been.
 * @type {readonly Migration[]}
 */
export const MIGRATIONS = Object.freeze([]);

/**
 * @typedef {{
 *   root: string,
 *   backup: string,
 *   migrations: { from: number, to: number, summary: string, wrote: string[] }[],
 *   updated: string[],
 *   proposed: string[],
 *   planted: string[],
 *   compile: { ok: boolean, written: string[], findings: Finding[] },
 *   region: "written" | "unchanged" | "no-file" | "no-region" | "not-compiled",
 * }} UpgradeResult
 */

/** `a.b.c` as three numbers; any pre-release or build suffix is ignored. @param {string} version */
function versionParts(version) {
  return version.split(/[-+]/, 1)[0].split(".").map(Number);
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let k = 0; k < 3; k++) {
    if ((x[k] ?? 0) !== (y[k] ?? 0)) return (x[k] ?? 0) - (y[k] ?? 0);
  }
  return 0;
}

/** Where the update proposal for a planted file goes. @param {string} rel */
export function proposalPath(rel) {
  return `${UPDATES_DIR}/${rel.endsWith(".md") ? rel : `${rel}.md`}`;
}

/** A fence longer than any backtick run in `text`, so the text sits inside it unchanged. @param {string} text */
function fenceFor(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * @param {string} rel  the planted file
 * @param {string} plantedSha  the hash planted.json holds for it
 * @param {string} text  what this lampstand plants there now
 */
function updateProposal(rel, plantedSha, text) {
  const fence = fenceFor(text);
  return [
    renderFrontmatter({ updates: rel, "planted-sha256": plantedSha, "upstream-sha256": contentHash(text) }).trimEnd(),
    `# Update to ${rel}`,
    "",
    `lampstand ${VERSION} plants a different \`${rel}\` from the one planted here, and the copy here has been edited since, so upgrade left it as it is. The text lampstand plants now is below. Take what you want from it into \`${rel}\`, then delete this file.`,
    "",
    fence,
    text.endsWith("\n") ? text.slice(0, -1) : text,
    fence,
    "",
  ].join("\n");
}

/**
 * Writes a proposal when its text differs from what is there.
 * @param {string} root @param {string} rel @param {string} text
 */
function writeProposal(root, rel, text) {
  const path = fullPath(root, rel);
  if (existsSync(path) && readText(path) === text) return;
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, text);
}

/**
 * The lattice: compared against the pack through the `adopted-hash` its frontmatter carries.
 * @param {string} root
 * @param {string} date
 * @returns {string | null}  the proposal written, or null
 */
function upgradeLattice(root, date) {
  const path = fullPath(root, LATTICE_FILE);
  if (!existsSync(path)) return null;
  const parsed = parseFrontmatter(readText(path), path);
  const origin = parsed.frontmatter?.origin;
  const adopted = parsed.frontmatter?.["adopted-hash"];
  if (typeof origin !== "string" || !origin.startsWith("pack:lattice@") || typeof adopted !== "string") return null;
  const packHash = contentHash(readText(LATTICE_PACK));
  if (packHash === adopted) return null;
  const rel = proposalPath(LATTICE_FILE);
  if (contentHash(parsed.body) === adopted) {
    writeProposal(root, rel, updateProposal(LATTICE_FILE, adopted, latticeFile(date).text));
  } else {
    const note = [
      renderFrontmatter({ updates: LATTICE_FILE, "adopted-hash": adopted, "upstream-sha256": packHash }).trimEnd(),
      "# The lattice pack changed",
      "",
      `The lattice pack in lampstand ${VERSION} differs from the text \`${LATTICE_FILE}\` was adopted from, and the copy here has been edited since, so no text is proposed. The pack is \`packs/lattice/LATTICE.md\` in the lampstand install; compare it with your copy and take what you want, then delete this file.`,
      "",
    ].join("\n");
    writeProposal(root, rel, note);
  }
  return rel;
}

/**
 * Copies house.toml and .house/ into a fresh folder under the house's state dir.
 * @param {string} root @param {string} houseId @param {NodeJS.ProcessEnv} env @param {Date} now
 */
function backup(root, houseId, env, now) {
  const parent = join(stateDirFor(root, houseId, env).dir, "backups");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, `upgrade-${now.toISOString().replace(/[:.]/g, "-")}-`));
  cpSync(join(root, "house.toml"), join(dir, "house.toml"));
  if (existsSync(join(root, ".house"))) cpSync(join(root, ".house"), join(dir, ".house"), { recursive: true });
  return dir;
}

/**
 * @param {{ root: string, env: NodeJS.ProcessEnv, now: Date, date: string }} options
 * @returns {UpgradeResult}
 */
export function upgradeHouse({ root, env, now, date }) {
  const config = loadHouseConfig(root);
  const min = config.plugin?.min;
  if (min !== undefined && compareVersions(min, VERSION) > 0) {
    throw fail("E_PLUGIN_TOO_OLD", `[plugin] min = "${min}" is newer than this lampstand (${VERSION}); upgrade lampstand before upgrading this house`, {
      path: join(root, "house.toml"),
    });
  }
  const planted = readPlanted(root);
  const saved = backup(root, config.house.id, env, now);

  /** @type {UpgradeResult["migrations"]} */
  const migrations = [];
  for (let schema = config.house.schema; schema < HOUSE_SCHEMA_VERSION; schema++) {
    const step = MIGRATIONS.find((migration) => migration.from === schema);
    if (!step || step.to !== schema + 1) throw new Error(`no migration takes house.schema ${schema} to ${schema + 1}`);
    migrations.push({ from: step.from, to: step.to, summary: step.summary, wrote: step.run(root) });
  }

  /** @type {Record<string, string>} */
  const values = { channel_manners: "", operator: config.operator?.name || "the operator" };
  for (const record of Object.values(planted.files)) Object.assign(values, record.values ?? {});
  /** @type {Record<"updated" | "proposed" | "planted", string[]>} */
  const out = { updated: [], proposed: [], planted: [] };
  for (const file of templateFiles(loadHouseConfig(root), values)) {
    const record = planted.files[file.rel];
    const path = fullPath(root, file.rel);
    const present = existsSync(path);
    const upstream = plantedHash(file.rel, file.text);
    if (record === undefined) {
      // Not planted before: new in this lampstand when missing, the operator's own file when present.
      if (present) continue;
      mkdirSync(dirname(path), { recursive: true });
      atomicWrite(path, file.text);
      planted.files[file.rel] = { sha256: upstream, source: file.source, ...(file.values ? { values: file.values } : {}) };
      out.planted.push(file.rel);
      continue;
    }
    if (!present || record.sha256 === upstream) continue;
    const here = plantedHash(file.rel, readText(path));
    if (here === upstream) {
      record.sha256 = upstream;
    } else if (here === record.sha256) {
      atomicWrite(path, file.text);
      record.sha256 = upstream;
      out.updated.push(file.rel);
    } else {
      // The edited file stays as it is. Recording the offered text as planted means this change is proposed once,
      // and a copy the operator brings to exactly this text counts as unedited at the next change.
      const rel = proposalPath(file.rel);
      writeProposal(root, rel, updateProposal(file.rel, record.sha256, file.text));
      record.sha256 = upstream;
      out.proposed.push(rel);
    }
  }
  const lattice = upgradeLattice(root, date);
  if (lattice !== null) out.proposed.push(lattice);
  writePlanted(root, planted);

  const run = runCompile(root);
  const compiled = run.errors.length === 0;
  return {
    root,
    backup: saved,
    migrations,
    ...out,
    compile: { ok: compiled, written: run.written, findings: run.findings },
    region: !compiled ? "not-compiled" : run.written.includes(AGENTS_FILE) ? "written" : writeAgentsRegion(root, run.compiled).status,
  };
}
