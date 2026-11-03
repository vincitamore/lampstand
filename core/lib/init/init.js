// @ts-check
// Planting a house: house.toml from the answers, every template manifest's files, the lattice unless declined,
// the house's folders and planted.json, all only where missing; then `git init` when the folder is not inside a
// repository, the compile, the AGENTS.md region and, with --default, default_house in per-user config. A re-run
// changes no byte: every write is conditional on a missing file or a differing content.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { hasHouseToml, loadHouseConfig, parseHouseToml } from "../config.js";
import { readText } from "../io.js";
import { runCompile } from "../constitution/run.js";
import { byCodePoint } from "../constitution/house.js";
import { setDefaultHouse } from "../seat/seat.js";
import {
  fullPath,
  HOUSE_FOLDERS,
  houseTomlText,
  latticeFile,
  PACKAGE_ROOT,
  plantFile,
  readPlanted,
  templateFiles,
  writePlanted,
} from "./plant.js";
import { AGENTS_FILE, writeAgentsRegion } from "./region.js";

/** @typedef {import("./plant.js").Answers} Answers */
/** @typedef {import("./plant.js").PlannedFile} PlannedFile */
/** @typedef {import("../constitution/rules.js").Finding} Finding */

/**
 * @typedef {{
 *   root: string,
 *   planted: string[],
 *   kept: string[],
 *   removed: string[],
 *   plantedJson: boolean,
 *   git: "initialized" | "existing" | "unavailable",
 *   compile: { ok: boolean, written: string[], findings: Finding[] },
 *   region: "written" | "unchanged" | "no-file" | "no-region" | "not-compiled",
 *   defaultHouse: { path: string, changed: boolean } | null,
 *   proposedJobs: { id: string, toml: string }[],
 * }} InitResult
 */

/**
 * Whether `dir` lies inside a git work tree, or "unavailable" when git cannot be run.
 * @param {string} dir
 * @returns {boolean | "unavailable"}
 */
function insideRepository(dir) {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8", windowsHide: true });
  if (result.error) return "unavailable";
  return result.status === 0 && result.stdout.trim() === "true";
}

/** @param {string} dir @returns {InitResult["git"]} */
function ensureRepository(dir) {
  const inside = insideRepository(dir);
  if (inside === "unavailable") return "unavailable";
  if (inside) return "existing";
  const result = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8", windowsHide: true });
  return result.error || result.status !== 0 ? "unavailable" : "initialized";
}

/**
 * The starter jobs init proposes and does not declare: the scheduler module is off at install, and a job enters
 * house.toml only when the operator puts it there.
 */
function starterJobs() {
  const dir = join(PACKAGE_ROOT, "templates", "jobs");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".toml"))
    .sort(byCodePoint)
    .map((name) => ({ id: name.slice(0, -".toml".length), toml: readText(join(dir, name)) }));
}

/**
 * Plants a house in `dir`.
 * @param {{
 *   dir: string,
 *   answers: Answers | null,
 *   channelManners?: string,
 *   makeDefault: boolean,
 *   env: NodeJS.ProcessEnv,
 *   date: string,
 * }} options
 *   `answers` is null when `dir` already holds house.toml, whose values then stand; `channelManners` fills voice.md
 *   if it is missing in that case.
 * @returns {InitResult}
 */
export function initHouse(options) {
  const exists = hasHouseToml(options.dir);
  if (!exists && options.answers === null) throw new Error("a house without house.toml needs answers");
  // house.toml is composed and validated before the first write, so a refused answer leaves no trace.
  const houseToml = exists ? null : houseTomlText(/** @type {Answers} */ (options.answers), randomUUID(), join(options.dir, "house.toml"));

  mkdirSync(options.dir, { recursive: true });
  const root = realpathSync.native(options.dir);
  const planted = readPlanted(root);
  /** @type {PlannedFile[]} */
  const files = [];
  if (houseToml !== null) {
    // house.toml is the house's marker: it is planted whenever it is missing, whatever planted.json says.
    delete planted.files["house.toml"];
    files.push({ rel: "house.toml", text: houseToml, source: "answers" });
  }
  const config = houseToml === null ? loadHouseConfig(root) : parseHouseToml(houseToml, fullPath(root, "house.toml"));
  const channelManners = options.answers?.channelManners ?? options.channelManners ?? "";
  // An agreement names the person who has care of the house; with no name given it says so in words, never a blank.
  const operator = options.answers?.operator || config.operator?.name || "the operator";
  files.push(...templateFiles(config, { channel_manners: channelManners, operator }));
  // The lattice and the large profile it needs are planted together with house.toml, never into a standing house.
  if (houseToml !== null && options.answers?.lattice) files.push(latticeFile(options.date));

  /** @type {Record<"planted" | "kept" | "removed", string[]>} */
  const outcome = { planted: [], kept: [], removed: [] };
  for (const file of files) outcome[plantFile(root, planted, file)].push(file.rel);
  for (const folder of HOUSE_FOLDERS) mkdirSync(fullPath(root, folder), { recursive: true });
  const plantedJson = writePlanted(root, planted);

  const git = ensureRepository(root);
  const run = runCompile(root);
  const compiled = run.errors.length === 0;
  // The compile refreshes the region itself; asking the writer again only reports the state (no file, no markers).
  const region = !compiled ? "not-compiled" : run.written.includes(AGENTS_FILE) ? "written" : writeAgentsRegion(root, run.compiled).status;
  const defaultHouse = options.makeDefault ? setDefaultHouse(options.env, root) : null;

  return {
    root,
    ...outcome,
    plantedJson,
    git,
    compile: { ok: compiled, written: run.written, findings: run.findings },
    region,
    defaultHouse,
    proposedJobs: starterJobs(),
  };
}
