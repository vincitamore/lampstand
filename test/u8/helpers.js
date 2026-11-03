// @ts-check
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, isolatedEnv, plant } from "../u1/helpers.js";

export { REPO, isolatedEnv, plant };

/** @typedef {{ after(fn: () => void): void }} TestContext */

/** Spawned CLIs compile a house each; bun's default 5 s per test is too short on a loaded machine. */
export const SLOW = { timeout: 60_000 };

// The CLI runs under Node, as Hermes spawns it; under `bun test` that is the node on PATH.
const NODE = process.versions.bun ? "node" : process.execPath;

/** A fresh real-path temp directory removed when the test ends. @param {TestContext} t */
export function tempDir(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-u8-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/**
 * An entry script registering every verb module's list, U8's included, the way core/bin/lampstand.js does, over
 * the package at `pkg` (the repository, or a copy standing in for a newer lampstand).
 * @param {string} pkg
 */
function entryScript(pkg) {
  const lib = (/** @type {string} */ rel) => JSON.stringify(pathToFileURL(join(pkg, "core", "lib", rel)).href);
  return [
    `import { Registry, runCli, versionVerb } from ${lib("cli.js")};`,
    `import { rootVerb } from ${lib("root.js")};`,
    `import { stateVerbs } from ${lib("state/verbs.js")};`,
    `import { verbs as constitutionVerbs } from ${lib("constitution/verbs.js")};`,
    `import { verbs as governanceVerbs } from ${lib("governance/verbs.js")};`,
    `import { verbs as orgVerbs } from ${lib("org/verbs.js")};`,
    `import { verbs as initVerbs } from ${lib("init/verbs.js")};`,
    `import { verbs as seatVerbs } from ${lib("seat/verbs.js")};`,
    "const registry = new Registry().register(versionVerb, rootVerb, ...stateVerbs, ...constitutionVerbs, ...governanceVerbs, ...orgVerbs, ...initVerbs, ...seatVerbs);",
    "process.exitCode = await runCli(registry, process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });",
    "",
  ].join("\n");
}

/**
 * Runs the CLI to completion with stdin a closed pipe, so it never sees a terminal.
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, pkg?: string, entryDir: string }} options
 *   entryDir: a temp directory to hold the entry script, outside every house
 */
export function lampstand(args, options) {
  const entry = join(options.entryDir, "lampstand-entry.mjs");
  writeFileSync(entry, entryScript(options.pkg ?? REPO));
  const result = spawnSync(NODE, [entry, ...args], { cwd: options.cwd, env: options.env, encoding: "utf8", input: "" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** @param {string} stdout */
export function envelope(stdout) {
  const lines = stdout.trimEnd().split("\n");
  if (lines.length !== 1) throw new Error(`--json must print exactly one line, got ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
}

export const PURPOSE = "The work is for the families our clinic serves.";

/** An answers file. @param {string} [extra] more TOML lines */
export function answersToml(extra = "") {
  return [
    'name = "test-house"',
    'operator = "ana"',
    'co_owners = ["ben"]',
    `purpose = ${JSON.stringify(PURPOSE)}`,
    'charter = "rules"',
    'ask_first = ["Ask before pushing to any remote."]',
    'channel_manners = ["## chat", "Short replies."]',
    extra,
  ].join("\n");
}

/**
 * One sha256 over every path under `dir`, files with their content and folders by name, `.git` included.
 * @param {string} dir
 */
export function treeHash(dir) {
  /** @type {string[]} */
  const lines = [];
  /** @param {string} rel */
  const walk = (rel) => {
    const entries = readdirSync(rel === "" ? dir : join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`dir ${child}`);
        walk(child);
      } else {
        lines.push(`${createHash("sha256").update(readFileSync(join(dir, child))).digest("hex")} ${child}`);
      }
    }
  };
  walk("");
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * A copy of the package's runtime files: a stand-in for a newer lampstand whose templates a test may change.
 * @param {string} dir  where to put it
 */
export function copyPackage(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of ["core", "schema", "templates", "packs", "package.json"]) cpSync(join(REPO, name), join(dir, name), { recursive: true });
  return dir;
}

/** @param {string} root @param {string} rel */
export function read(root, rel) {
  return readFileSync(join(root, ...rel.split("/")), "utf8");
}
