// @ts-check
// What the release gates share: which files a repository holds, which of them ship, how a glob matches, and one
// way to read arguments and report. Every gate takes `--root <dir>` (default: this checkout), so a test can point it
// at a planted tree. Exit codes follow the CLI contract: 0 clean, 1 finding, 2 could not run, 64 usage.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A gate that could not run: exit 2, as distinct from a finding. */
export class GateError extends Error {}

/** A bad command line: exit 64. */
export class UsageError extends Error {}

/**
 * Reads `--name value` / `--name=value` string flags and bare `--name` booleans. `--root` is always accepted.
 * @param {string[]} argv
 * @param {Record<string, "string" | "boolean">} [spec]
 * @returns {{ root: string, flags: Record<string, string | boolean>, positional: string[] }}
 */
export function parseArgs(argv, spec = {}) {
  /** @type {Record<string, "string" | "boolean">} */
  const all = { root: "string", ...spec };
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(arg);
    if (!match) {
      if (arg.startsWith("-")) throw new UsageError(`unknown flag ${arg}`);
      positional.push(arg);
      continue;
    }
    const [, name, inline] = match;
    const type = all[name];
    if (type === undefined) throw new UsageError(`unknown flag --${name}`);
    if (type === "boolean") {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
    } else {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    }
  }
  const root = resolve(typeof flags.root === "string" ? flags.root : REPO);
  return { root, flags, positional };
}

/**
 * Runs a gate's body and exits with its code; usage and infrastructure errors are printed with the gate's name.
 * @param {string} name
 * @param {string} usage
 * @param {() => number | Promise<number>} body  returns (or resolves to) 0 or 1
 */
export function runGate(name, usage, body) {
  /** @param {unknown} error */
  const codeFor = (error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${name}: ${error.message}\nusage: ${usage}\n`);
      return 64;
    }
    if (error instanceof GateError) {
      process.stderr.write(`${name}: could not run: ${error.message}\n`);
      return 2;
    }
    throw error;
  };
  let result;
  try {
    result = body();
  } catch (error) {
    process.exitCode = codeFor(error);
    return;
  }
  if (typeof result === "number") process.exitCode = result;
  else result.then((code) => (process.exitCode = code), (error) => (process.exitCode = codeFor(error)));
}

/**
 * Every file the repository holds: tracked and untracked files git does not ignore, as sorted `/`-separated paths.
 * Asking git is what keeps `node_modules/`, `__pycache__/` and `.campaign/` out without a second ignore list.
 * @param {string} root
 */
export function repoFiles(root) {
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 256 << 20,
    windowsHide: true,
  });
  if (listed.error) throw new GateError(`git ls-files: ${listed.error.message}`);
  if (listed.status !== 0) throw new GateError(`git ls-files in ${root}: ${listed.stderr.trim()}`);
  const paths = new Set(listed.stdout.split("\0").filter(Boolean));
  // A path deleted from the working tree but still in the index is not a file to read.
  return [...paths].filter((path) => isFile(join(root, path))).sort(byPath);
}

/** Byte-order comparison of `/`-separated paths, the same on every platform. @param {string} a @param {string} b */
export function byPath(a, b) {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return Buffer.compare(x, y);
}

/** @param {string} path */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A glob over `/`-separated paths: `**` spans any number of whole segments, `*` and `?` stay inside one segment, and
 * a pattern ending in `/` matches everything below that directory.
 * @param {string} pattern
 */
export function globRegExp(pattern) {
  const source = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "*" && source[i + 1] === "*") {
      const slashAfter = source[i + 2] === "/";
      out += slashAfter ? "(?:[^/]+/)*" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** @typedef {{ include: string[], exclude: string[] }} Allowlist */

export const ALLOWLIST_FILE = "dev/release-allowlist.json";

/**
 * The release allowlist of the tree at `root`.
 * @param {string} root
 * @returns {Allowlist}
 */
export function readAllowlist(root) {
  const path = join(root, ...ALLOWLIST_FILE.split("/"));
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GateError(`${ALLOWLIST_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const strings = (/** @type {unknown} */ value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
  if (!strings(data.include) || (data.exclude !== undefined && !strings(data.exclude))) {
    throw new GateError(`${ALLOWLIST_FILE}: include (and exclude, if present) must be arrays of non-empty glob strings`);
  }
  return { include: data.include, exclude: data.exclude ?? [] };
}

/**
 * The repository's files the allowlist ships.
 * @param {string} root
 * @param {string[]} [files]  defaults to repoFiles(root)
 */
export function shippedFiles(root, files = repoFiles(root)) {
  const { include, exclude } = readAllowlist(root);
  const keep = include.map(globRegExp);
  const drop = exclude.map(globRegExp);
  return files.filter((path) => keep.some((re) => re.test(path)) && !drop.some((re) => re.test(path)));
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The file's text when it is UTF-8 without NUL bytes, else null (a binary file has no lines to report).
 * @param {string} path
 */
export function readTextFile(path) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return null;
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 1-based line number of each offset, by binary search over line starts.
 * @param {string} text
 */
export function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  /** @param {number} offset */
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Prints findings (one per line) or the pass line, and returns the exit code.
 * @param {string} name
 * @param {string[]} findings
 * @param {string} passLine
 * @param {string} failLine
 */
export function report(name, findings, passLine, failLine) {
  if (findings.length === 0) {
    process.stdout.write(`${name}: ${passLine}\n`);
    return 0;
  }
  process.stdout.write(`${findings.join("\n")}\n`);
  process.stderr.write(`${name}: ${failLine}\n`);
  return 1;
}
