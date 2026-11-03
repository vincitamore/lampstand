// @ts-check
// House resolution, in this order and no other:
//   1. HOUSE_ROOT, which must hold house.toml; otherwise E_HOUSE_ROOT_INVALID with no fallback, because silently
//      using a different house than the one the user named would write into the wrong repository.
//   2. Walk up from the working directory to the filesystem root, looking for house.toml. Git roots do not stop the
//      walk, so an independent repository nested inside a house still finds it.
//   3. Only when the caller's surface has no workspace (messaging, scheduled ticks): default_house from per-user
//      config. A surface with a workspace never falls back to it, so work in an unrelated folder stays unhoused.
//   4. Dormant: a value, not an error. The caller decides what dormant means for it.
// A Python twin implements the same rules; schema/conformance/root/ holds the vectors both pass.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { hasHouseToml, loadUserConfig, userConfigPath } from "./config.js";
import { fail } from "./errors.js";

/** @typedef {"HOUSE_ROOT" | "walk-up" | "default_house" | "dormant"} RootRule */
/** @typedef {{ rule: Exclude<RootRule, "dormant">, root: string } | { rule: "dormant", root: null }} Resolution */

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, workspace?: boolean }} [options]
 *   `workspace: false` declares a surface with no workspace, the only case in which default_house is consulted.
 * @returns {Resolution}
 */
export function resolveHouse(options = {}) {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const workspace = options.workspace ?? true;

  // An empty HOUSE_ROOT is treated as unset: shells and service managers export empty variables routinely.
  const named = env.HOUSE_ROOT;
  if (named) {
    const dir = resolve(cwd, named);
    if (!hasHouseToml(dir)) {
      throw fail("E_HOUSE_ROOT_INVALID", `HOUSE_ROOT=${named} does not hold house.toml (resolved to ${dir})`);
    }
    return { rule: "HOUSE_ROOT", root: canonical(dir) };
  }

  for (let dir = cwd; ; dir = dirname(dir)) {
    if (hasHouseToml(dir)) return { rule: "walk-up", root: canonical(dir) };
    if (dirname(dir) === dir) break;
  }

  if (!workspace) {
    const fallback = loadUserConfig(env).default_house;
    if (fallback !== undefined) {
      const path = userConfigPath(env);
      if (!isAbsolute(fallback)) {
        throw fail("E_DEFAULT_HOUSE_INVALID", `default_house must be an absolute path, got ${JSON.stringify(fallback)}`, { path });
      }
      if (!hasHouseToml(fallback)) {
        throw fail("E_DEFAULT_HOUSE_INVALID", `default_house ${fallback} does not hold house.toml`, { path });
      }
      return { rule: "default_house", root: canonical(fallback) };
    }
  }

  return { rule: "dormant", root: null };
}

/**
 * The real path of a directory, so one house reached through a symlink or a differently-cased path has one identity.
 * @param {string} dir
 */
function canonical(dir) {
  return realpathSync.native(dir);
}

/** Flags shared by every verb that resolves a house. */
export const WORKSPACE_FLAGS = Object.freeze({
  "no-workspace": {
    type: /** @type {const} */ ("boolean"),
    summary: "the calling surface has no workspace (messaging, scheduled ticks): allow default_house",
  },
});

/** @type {import("./cli.js").Verb} */
export const rootVerb = {
  name: "root",
  summary: "print the resolved house and the resolution rule that found it",
  flags: WORKSPACE_FLAGS,
  run({ env, cwd, flags }) {
    const found = resolveHouse({ env, cwd, workspace: !flags["no-workspace"] });
    return {
      data: { rule: found.rule, root: found.root },
      text: found.root === null ? `dormant: no house resolved from ${resolve(cwd)}` : `${found.root}\nrule: ${found.rule}`,
    };
  },
};
