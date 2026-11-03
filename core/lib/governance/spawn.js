// @ts-check
// Runs programs the way a shell would find them: the first match on PATH wins, and on Windows PATHEXT is honoured, so
// a `git.cmd` or `npx.cmd` earlier on PATH is used just as it is at a prompt. libuv alone finds only .exe and .com,
// and refuses to start a batch file without a shell, so batch files go through cmd.exe with every argument quoted.
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** @typedef {import("node:child_process").SpawnSyncOptions} SpawnSyncOptions */

const WINDOWS = process.platform === "win32";

/**
 * Reads an environment variable by name, case-insensitively on Windows, where a copied environment keeps the
 * system's spelling (`Path`, `ComSpec`).
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
export function envValue(env, name) {
  if (!WINDOWS) return env[name];
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

/**
 * The file `name` resolves to on PATH, or null. A name holding a path separator is returned unchanged.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 */
export function findExecutable(name, env) {
  if (/[\\/]/.test(name)) return name;
  const dirs = (envValue(env, "PATH") ?? "").split(delimiter).filter(Boolean);
  const extensions = WINDOWS ? ["", ...(envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      // On Windows a bare name without an extension is not runnable, only a candidate when it already has one.
      if (WINDOWS && extension === "" && !/\.[^\\/.]+$/.test(name)) continue;
      const candidate = join(dir, name + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!WINDOWS) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

/**
 * spawnSync for `file` resolved on PATH. Batch files run under cmd.exe; an argument cmd.exe would reinterpret even
 * inside quotes (`"`, `%`, a line break, a trailing backslash) is refused with an Error rather than mangled.
 * @param {string} file
 * @param {string[]} args
 * @param {SpawnSyncOptions & { env: NodeJS.ProcessEnv }} options
 */
export function spawnResolved(file, args, options) {
  const resolved = findExecutable(file, options.env) ?? file;
  if (WINDOWS && /\.(?:cmd|bat)$/i.test(resolved)) {
    for (const arg of [resolved, ...args]) {
      if (/["%\r\n]|\\$/.test(arg)) throw new Error(`cannot pass ${JSON.stringify(arg)} to the batch file ${resolved} safely`);
    }
    const line = [resolved, ...args].map((arg) => `"${arg}"`).join(" ");
    const shell = envValue(options.env, "ComSpec") ?? "cmd.exe";
    return spawnSync(shell, ["/d", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true });
  }
  return spawnSync(resolved, args, options);
}
