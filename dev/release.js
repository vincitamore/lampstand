#!/usr/bin/env node
// @ts-check
// Builds the release tree: exactly the repository files dev/release-allowlist.json matches, copied byte for byte into
// an empty output directory, plus a manifest of every path with its size and sha256 written beside the tree (not in
// it, so the tree holds only allowlisted files). Paths are sorted by their UTF-8 bytes and nothing time- or
// machine-dependent is recorded, so the same input tree gives byte-identical output.
//
// Every extension below is one the Hermes install scanner reads, so everything shipped but the licence texts is
// scanned: any other file is refused, naming it, and nothing is written. dev/, test/, .github/ and .campaign/ never
// ship, whatever the allowlist says.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { GateError, parseArgs, report, runGate, shippedFiles, UsageError } from "./gate-lib.js";

export const EXTENSIONS = Object.freeze([".js", ".ts", ".py", ".md", ".json", ".toml", ".yaml", ".txt"]);
const LICENCE = /^(?:LICEN[CS]E|COPYING)$/;
const NEVER = /^(?:dev|test|\.github|\.campaign)\//;

/** @param {string} path */
function permitted(path) {
  const name = posix.basename(path);
  return LICENCE.test(name) || EXTENSIONS.includes(posix.extname(name).toLowerCase());
}

/** @param {string} dir */
function isEmptyOrMissing(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return true;
  }
  return readdirSync(dir).length === 0;
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

runGate("release", "node dev/release.js --out <empty dir> [--manifest <file>] [--root <dir>]", () => {
  const { root, flags } = parseArgs(process.argv.slice(2), { out: "string", manifest: "string" });
  if (typeof flags.out !== "string") throw new UsageError("--out is required");
  const out = resolve(flags.out);
  const manifestPath = resolve(typeof flags.manifest === "string" ? flags.manifest : `${out}.manifest.json`);
  const rel = relative(out, manifestPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new UsageError("the manifest must be written outside the release tree");
  if (!isEmptyOrMissing(out)) throw new UsageError(`${out} is not an empty directory`);

  const files = shippedFiles(root);
  const refused = [
    ...files.filter((path) => NEVER.test(path)).map((path) => `release: ${path}: dev/, test/, .github/ and .campaign/ never ship`),
    ...files.filter((path) => !NEVER.test(path) && !permitted(path)).map(
      (path) => `release: ${path}: extension ${JSON.stringify(posix.extname(path) || "(none)")} is not one the release ships (${EXTENSIONS.join(" ")} or a licence file)`,
    ),
  ];
  if (refused.length > 0) return report("release", refused, "", `refused ${refused.length} files; nothing written`);
  if (files.length === 0) throw new GateError("the allowlist matches no files");

  /** @type {{ path: string, bytes: number, sha256: string }[]} */
  const entries = [];
  for (const path of files) {
    const bytes = readFileSync(join(root, ...path.split("/")));
    const target = join(out, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    entries.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const tree = createHash("sha256");
  for (const entry of entries) tree.update(`${entry.sha256}  ${entry.path}\n`, "utf8");
  const manifest = { generator: "lampstand dev/release.js", files: entries.length, tree: tree.digest("hex"), entries };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return report("release", [], `${entries.length} files in ${out}; tree ${manifest.tree}; manifest ${manifestPath}`, "");
});
