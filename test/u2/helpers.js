// @ts-check
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentHash } from "../../core/lib/io.js";
import { BIN, HOUSE_ID, REPO, isolatedEnv } from "../u1/helpers.js";

export { BIN, REPO, isolatedEnv };

/** @typedef {{ after(fn: () => void): void }} TestContext */

/** A fresh real-path temp directory removed when the test ends. @param {TestContext} t */
export function tempDir(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-u2-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** @param {string} root @param {Record<string, string>} files */
export function plant(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export const LATTICE = readFileSync(join(REPO, "packs", "lattice", "LATTICE.md"), "utf8");

/** principles/lattice.md as init plants it: the pack verbatim under its provenance frontmatter. */
export const LATTICE_ADOPTED = `---\norigin: "pack:lattice@1"\nadopted: "2026-11-02"\nadopted-hash: "${contentHash(LATTICE)}"\n---\n${LATTICE}`;

/** @param {string} rel */
export function template(rel) {
  return readFileSync(join(REPO, "templates", "constitution", ...rel.split("/")), "utf8");
}

export const PURPOSE = "The work is for the families our clinic serves: records they can trust, and time back for care.";
export const ASK_FIRST = [
  "Ask before pushing to any remote.",
  "Ask before deleting anything outside the house.",
  "Ask before spending money or contacting anyone on the operator's behalf.",
];

/**
 * @param {{ profile?: string, mode?: string, purpose?: string, askFirst?: string[], extra?: string }} [options]
 */
export function houseToml(options = {}) {
  const asks = (options.askFirst ?? ASK_FIRST).map((line) => JSON.stringify(line)).join(", ");
  return [
    "[house]",
    "schema = 1",
    `id = "${HOUSE_ID}"`,
    'name = "test-house"',
    "[purpose]",
    `text = ${JSON.stringify(options.purpose ?? PURPOSE)}`,
    "[charter]",
    `mode = "${options.mode ?? "rules"}"`,
    `ask_first = [${asks}]`,
    "[budget]",
    `profile = "${options.profile ?? "large"}"`,
    options.extra ?? "",
  ].join("\n");
}

/**
 * Plants a house with the lattice adopted and every constitution template in place.
 * @param {string} root
 * @param {Parameters<typeof houseToml>[0] & { lattice?: boolean }} [options]
 */
export function plantHouse(root, options = {}) {
  plant(root, {
    "house.toml": houseToml(options),
    "charter/core.md": template(`charter/core.${options.mode ?? "rules"}.md`),
    "charter/record.md": template("charter/record.md"),
    "reflexes/INDEX.md": template("reflexes/INDEX.md"),
    "voice.md": template("voice.md").replace("{{channel_manners}}", "## chat\n\nShort answers; no headings."),
    "curation.md": template("curation.md"),
    "state/current.md": template("state/current.md"),
    ...(options.lattice === false ? {} : { "principles/lattice.md": LATTICE_ADOPTED }),
  });
}

/** @param {string} id @param {string} scope @param {Record<string, string>} [extra] */
export function reflexFile(id, scope, extra = {}) {
  const fields = {
    scope,
    summary: `${id} summary line`,
    occasion: `${id} happened`,
    "falsified-when": `${id} stops helping`,
    revise: `rewrite ${id}`,
    adopted: "2026-11-02",
    "adopted-hash": "0".repeat(64),
    ...extra,
  };
  const yaml = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  return `---\n${yaml}\n---\nBody of ${id}.\n`;
}

// The CLI runs under Node: that is how Hermes spawns it. Under `bun test` the same file still spawns node.
const NODE = process.versions.bun ? "node" : process.execPath;

/** @param {string[]} args @param {{ cwd: string, env: NodeJS.ProcessEnv }} options */
export function lampstand(args, options) {
  const result = spawnSync(NODE, [BIN, ...args], { ...options, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** @param {string} stdout */
export function envelope(stdout) {
  const lines = stdout.trimEnd().split("\n");
  if (lines.length !== 1) throw new Error(`--json must print exactly one line, got ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
}

/** Runs git in `cwd` with a fixed identity and no user or system config. @param {string} cwd @param {string[]} args */
export function git(cwd, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, ".git-test-config") };
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
