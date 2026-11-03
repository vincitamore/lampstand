// @ts-check
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Registry, runCli } from "../../core/lib/cli.js";
import { verbs } from "../../core/lib/org/verbs.js";
import { HOUSE_ID, HOUSE_TOML, isolatedEnv, plant, tempDir } from "../u1/helpers.js";

export { HOUSE_ID, HOUSE_TOML, isolatedEnv, plant, tempDir };

/** The org verbs in a registry of their own, so the tests do not depend on how core/bin registers them. */
const registry = new Registry().register(...verbs);

/**
 * A temp house (house.toml plus `files`) and an environment whose state and config roots are temp directories.
 * @param {import("../u1/helpers.js").TestContext} t
 * @param {{ toml?: string, files?: Record<string, string> }} [options]
 */
export function makeHouse(t, options = {}) {
  const dir = tempDir(t);
  const root = join(dir, "house");
  plant(root, { "house.toml": `${HOUSE_TOML}${options.toml ?? ""}`, ...options.files });
  return { root, env: isolatedEnv(dir) };
}

/**
 * Runs one CLI invocation in-process with the house as cwd.
 * @param {string[]} args
 * @param {{ root: string, env: NodeJS.ProcessEnv, cwd?: string }} house
 */
export async function cli(args, house) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(registry, args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    env: house.env,
    cwd: house.cwd ?? house.root,
  });
  return { code, stdout, stderr };
}

/**
 * Runs with --json and returns the parsed envelope with the exit code.
 * @param {string[]} args
 * @param {{ root: string, env: NodeJS.ProcessEnv, cwd?: string }} house
 */
export async function cliJson(args, house) {
  const result = await cli([...args, "--json"], house);
  return { code: result.code, body: JSON.parse(result.stdout), stderr: result.stderr };
}

/** @param {string} root @param {string} rel */
export function read(root, rel) {
  return readFileSync(join(root, ...rel.split("/")), "utf8");
}
