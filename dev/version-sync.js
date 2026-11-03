#!/usr/bin/env node
// @ts-check
// Exits 0 only when package.json, plugin.yaml and the newest released CHANGELOG.md heading carry one version
// (and, with --tag vX.Y.Z, the release tag matches it): npm and Hermes each read their own manifest,
// so a release whose manifests disagree installs as two different versions.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} message */
function usage(message) {
  process.stderr.write(`version-sync: ${message}\nusage: node dev/version-sync.js [--tag vX.Y.Z]\n`);
  process.exit(64);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {string | undefined} */
  let tag;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tag" && i + 1 < argv.length && tag === undefined) tag = argv[++i];
    else usage(`unexpected argument ${JSON.stringify(argv[i])}`);
  }
  return { tag };
}

/** @param {string} file */
function read(file) {
  return readFileSync(join(root, file), "utf8");
}

/** @returns {unknown} */
function packageVersion() {
  return JSON.parse(read("package.json")).version;
}

// Only the top-level scalar is read: a full YAML parser would be a dependency, and the version line is
// the one fact this gate needs from plugin.yaml.
function pluginVersion() {
  const matches = [...read("plugin.yaml").matchAll(/^version:[ \t]*(.*?)[ \t]*(?:[ \t]#.*)?\r?$/gm)];
  if (matches.length !== 1) throw new Error(`expected one top-level version key, found ${matches.length}`);
  const raw = matches[0][1];
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  return quoted ? quoted[2] : raw;
}

/**
 * The newest released version in CHANGELOG.md. An `## Unreleased` section may sit above it between releases; a
 * release (--tag) must have renamed it to the version first.
 * @param {boolean} releasing
 */
function changelogVersion(releasing) {
  const headings = [...read("CHANGELOG.md").matchAll(/^## (.*?)[ \t]*\r?$/gm)].map((match) => match[1]);
  if (headings.length === 0) throw new Error("no '## ' heading");
  if (headings[0] !== "Unreleased") return headings[0];
  if (releasing) throw new Error("the first heading is 'Unreleased'; rename it to the version being released");
  if (headings.length === 1) throw new Error("no released version below 'Unreleased'");
  return headings[1];
}

const { tag } = parseArgs(process.argv.slice(2));

/** @type {[string, () => unknown][]} */
const sources = [
  ["package.json version", packageVersion],
  ["plugin.yaml version", pluginVersion],
  ["CHANGELOG.md newest release heading", () => changelogVersion(tag !== undefined)],
];
/** @type {[string, unknown][]} */
const found = [];
const errors = [];
for (const [label, readVersion] of sources) {
  try {
    found.push([label, readVersion()]);
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (tag !== undefined) {
  if (tag.startsWith("v")) found.push(["tag", tag.slice(1)]);
  else errors.push(`tag: ${JSON.stringify(tag)} is not of the form vX.Y.Z`);
}

const expected = found[0]?.[1];
const agree = errors.length === 0 && typeof expected === "string" && expected !== "" &&
  found.every(([, version]) => version === expected);
if (agree) {
  process.stdout.write(`version-sync: ${expected} (${found.map(([label]) => label).join(", ")})\n`);
  process.exit(0);
}
const lines = [...errors, ...found.map(([label, version]) => `${label}: ${JSON.stringify(version)}`)];
process.stderr.write(`version-sync: versions disagree\n${lines.map((line) => `  ${line}`).join("\n")}\n`);
process.exit(1);
