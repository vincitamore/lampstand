// @ts-check
// Compile against the filesystem: load the house, compile it in memory, run the curation rules, and either write
// the projections (only when no rule reports an error, so a refused compile leaves the previous projections in
// place) or byte-compare them with what is on disk.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fail } from "../errors.js";
import { atomicWrite, errorMessage } from "../io.js";
import { AGENTS_FILE, agentsRegionStale, writeAgentsRegion } from "../init/region.js";
import { previousManifest } from "./budgets.js";
import { compileHouse, GENERATED_DIR } from "./compile.js";
import { loadHouse } from "./house.js";
import { KNOWN_GATES, runRules } from "./rules.js";

/** @typedef {import("./rules.js").Finding} Finding */
/**
 * @typedef {{
 *   house: import("./house.js").House,
 *   compiled: import("./compile.js").Compiled,
 *   findings: Finding[],
 *   errors: Finding[],
 *   stale: string[],
 *   written: string[],
 * }} CompileRun
 */

/** @param {string} root */
function generatedDir(root) {
  return join(root, ...GENERATED_DIR.split("/"));
}

/**
 * The generated files on disk, by name, read as raw UTF-8 so a byte difference (line endings included) counts.
 * @param {string} root
 */
export function readGenerated(root) {
  const dir = generatedDir(root);
  /** @type {Map<string, string>} */
  const out = new Map();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(md|json)$/.test(entry.name)) continue;
    try {
      out.set(entry.name, readFileSync(join(dir, entry.name), "utf8"));
    } catch (cause) {
      throw fail("E_IO", `cannot read: ${errorMessage(cause)}`, { path: join(dir, entry.name), cause });
    }
  }
  return out;
}

/**
 * @param {string} root
 * @param {{ check?: boolean }} [options]  check: compare with disk and write nothing
 * @returns {CompileRun}
 */
export function runCompile(root, options = {}) {
  const house = loadHouse(root);
  const compiled = compileHouse(house);
  const onDisk = readGenerated(root);
  const findings = runRules({ house, compiled, previous: previousManifest(root), onDisk: options.check ? onDisk : null, gates: KNOWN_GATES });
  const errors = findings.filter((finding) => finding.level === "error");
  const stale = findings.filter((f) => f.rule === "generated-fresh").map((f) => /** @type {string} */ (f.path));
  /** @type {string[]} */
  const written = [];
  if (!options.check && errors.length === 0) {
    const dir = generatedDir(root);
    mkdirSync(dir, { recursive: true });
    const produced = new Set(compiled.files.map((file) => file.name));
    for (const file of compiled.files) {
      if (onDisk.get(file.name) === file.text) continue;
      atomicWrite(join(dir, file.name), file.text);
      written.push(`${GENERATED_DIR}/${file.name}`);
    }
    // The directory is the compiler's alone: a projection it no longer produces would otherwise be loaded stale.
    for (const name of onDisk.keys()) {
      if (!produced.has(name)) {
        rmSync(join(dir, name), { force: true });
        written.push(`${GENERATED_DIR}/${name}`);
      }
    }
    // The house's AGENTS.md region is a projection too: refreshed in the same act, so it never lags the compile.
    if (writeAgentsRegion(root, compiled).status === "written") written.push(AGENTS_FILE);
  }
  if (options.check && agentsRegionStale(root, compiled)) stale.push(AGENTS_FILE);
  return { house, compiled, findings, errors, stale, written };
}
