// @ts-check
// Small helpers doctor's fact gatherers share: failure capture, PATH lookup, home and path handling, and a bounded
// command runner.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { isLampstandError } from "../errors.js";
import { normalizeLf, stripBom } from "../io.js";
import { parseYamlMapping } from "../parse/yaml.js";

/** @typedef {{ code: string, message: string }} Failure */
/** @typedef {{ status: number | null, stdout: string, stderr: string }} CommandResult */
/** @typedef {(file: string, args: string[]) => CommandResult} Runner */

/**
 * Runs `fn`, turning a lampstand error or a file-system error into a Failure. Any other exception is a bug and
 * propagates, so doctor never reports its own defect as a fault of the house.
 * @template T
 * @param {() => T} fn
 * @returns {{ value: T } | { failure: Failure }}
 */
export function attempt(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    if (isLampstandError(error)) return { failure: { code: error.code, message: error.message } };
    const errno = /** @type {NodeJS.ErrnoException} */ (error);
    if (error instanceof Error && typeof errno.syscall === "string") return { failure: { code: String(errno.code ?? "E_IO"), message: error.message } };
    throw error;
  }
}

/**
 * The user's home directory as the environment names it, so pointing HOME (USERPROFILE on Windows) at a temp
 * directory moves every host location with it.
 * @param {NodeJS.ProcessEnv} env
 */
export function homeOf(env) {
  const named = process.platform === "win32" ? env.USERPROFILE : env.HOME;
  return named && isAbsolute(named) ? named : homedir();
}

/**
 * `~` and `~/...` expanded against `home`; anything else unchanged.
 * @param {string} path
 * @param {string} home
 */
export function expandHome(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/** @param {string} path */
export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** @param {string} path */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or lies beneath it. @param {string} child @param {string} parent */
export function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The first executable named `name` on PATH, or null. On Windows each PATHEXT extension is tried, as the shell does.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 */
export function which(name, env) {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => dir !== "");
  // Windows runs a bare name only with a PATHEXT extension, and npm puts an extensionless sh script beside each .cmd
  // shim, which spawning cannot run; so there a bare name matches PATHEXT names only.
  const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "");
  const extensions = process.platform === "win32" && !/\.[^\\/.]+$/.test(name) ? pathext : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext.toLowerCase()}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Runs a command to completion with a bounded wait. Windows runs `.cmd` and `.bat` shims only through the shell;
 * the arguments doctor passes are constants, so the joined command line carries nothing from outside.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Runner}
 */
export function commandRunner(env) {
  return (file, args) => {
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    const result = shim
      ? spawnSync(`"${file}" ${args.join(" ")}`, { encoding: "utf8", env, shell: true, timeout: 15_000, windowsHide: true })
      : spawnSync(file, args, { encoding: "utf8", env, timeout: 15_000, windowsHide: true });
    if (result.error) return { status: null, stdout: "", stderr: result.error.message };
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/** @param {string} pattern */
function escapeRegExp(pattern) {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The value of top-level `key` in a host's YAML file, read by lampstand's YAML subset from that key's block alone:
 * the file as a whole may use constructs outside the subset, while the block lampstand needs usually does not.
 * Undefined when the key is absent; a block outside the subset is refused, never guessed at.
 * @param {string} text
 * @param {string} key
 * @param {string} path
 * @returns {unknown}
 */
export function topLevelValue(text, key, path) {
  const lines = normalizeLf(stripBom(text)).split("\n");
  const head = new RegExp(`^${escapeRegExp(key)}:(?:[ \\t]|$)`);
  const start = lines.findIndex((line) => head.test(line));
  if (start < 0) return undefined;
  let end = start + 1;
  // A block runs until the next line at column 1 that is not a comment or a sequence item of this key.
  while (end < lines.length && (lines[end].trim() === "" || /^[ \t#]/.test(lines[end]) || /^- /.test(lines[end]))) end++;
  return parseYamlMapping(lines.slice(start, end).join("\n"), path, start + 1)[key];
}

/**
 * Reads a YAML key's value from a file, or records why it could not.
 * @param {string} path
 * @param {string} key
 * @param {Failure[]} unreadable
 * @returns {unknown}
 */
export function yamlKey(path, key, unreadable) {
  if (!isFile(path)) return undefined;
  const read = attempt(() => topLevelValue(readFileSync(path, "utf8"), key, path));
  if ("failure" in read) {
    unreadable.push(read.failure);
    return undefined;
  }
  return read.value;
}
