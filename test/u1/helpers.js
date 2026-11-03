// @ts-check
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const BIN = join(REPO, "core", "bin", "lampstand.js");

/** @typedef {{ after(fn: () => void): void }} TestContext */

/**
 * A fresh real-path temp directory removed when the test ends.
 * @param {TestContext} t
 */
export function tempDir(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-u1-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/**
 * An environment whose state and config roots are temp directories and that carries no HOUSE_ROOT, so nothing a
 * test runs reads or writes the real per-user locations. PATH and the like are kept so child processes start.
 * @param {string} dir  a temp directory to hold the roots
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedEnv(dir) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, LAMPSTAND_STATE_ROOT: join(dir, "state-root"), LAMPSTAND_CONFIG_ROOT: join(dir, "config-root") };
  delete env.HOUSE_ROOT;
  // The child's local date must be the test's: bun's runner works in UTC without setting TZ, so a node child would
  // otherwise use the machine's zone and write a different date in the hours the two calendars differ.
  env.TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return env;
}

/**
 * Writes `files` (relative path to content) under `root`, creating parents.
 * @param {string} root
 * @param {Record<string, string>} files
 */
export function plant(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export const HOUSE_ID = "0b9a1c2e-4f5d-4e6a-8b7c-9d0e1f2a3b4c";
export const HOUSE_TOML = `[house]\nschema = 1\nid = "${HOUSE_ID}"\nname = "test-house"\n`;

/**
 * Every vector of every JSON file in a conformance directory.
 * @param {string} kind  root | hash | toml | frontmatter
 * @returns {{ file: string, vector: any }[]}
 */
export function vectors(kind) {
  const dir = join(REPO, "schema", "conformance", kind);
  const out = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    for (const vector of JSON.parse(readFileSync(join(dir, file), "utf8")).vectors) out.push({ file, vector });
  }
  return out;
}
