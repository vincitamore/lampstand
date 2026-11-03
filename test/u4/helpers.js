// @ts-check
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHouse } from "../../core/lib/governance/jobs.js";
import { BIN, HOUSE_TOML, isolatedEnv, plant } from "../u1/helpers.js";

export { HOUSE_ID, tempDir } from "../u1/helpers.js";

/** The CLI runs under Node, as Hermes spawns it; under `bun test` that is the node on PATH. */
export const NODE = process.versions.bun ? "node" : process.execPath;
export const JOB = fileURLToPath(new URL("./fixtures/job.js", import.meta.url));

/** Tests that start several processes; bun's default 5 s per test is too short on a loaded machine. */
export const SPAWNS = { timeout: 120_000 };

/** A TOML literal string; test paths never hold a single quote. @param {string} text */
export const lit = (text) => `'${text}'`;

/**
 * The argv of a scripted job (see fixtures/job.js) as a TOML array.
 * @param {string[]} steps
 */
export function jobArgv(...steps) {
  return `[${[process.execPath, JOB, ...steps].map(lit).join(", ")}]`;
}

/**
 * An isolated environment whose git reads no system or user configuration but a temp one, so a developer's hooks,
 * signing or autocrlf cannot change what a test sees.
 * @param {string} dir
 */
export function gitEnv(dir) {
  const env = isolatedEnv(dir);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "gitconfig");
  writeFileSync(config, "[user]\n\tname = u4\n\temail = u4@example.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = config;
  return env;
}

/**
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} args
 */
export function git(cwd, env, ...args) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** The sorted name list of a commit. @param {string} root @param {NodeJS.ProcessEnv} env @param {string} rev */
export function namesIn(root, env, rev) {
  return git(root, env, "show", "--name-only", "--format=", "-z", rev).split("\0").filter(Boolean).sort();
}

/**
 * A house in a fresh git repository with one commit holding house.toml.
 * @param {string} dir  a temp directory
 * @param {string} jobs  TOML text appended after [house] (job tables, [modules])
 */
export function makeHouse(dir, jobs) {
  const env = gitEnv(dir);
  const root = join(dir, "house");
  plant(root, { "house.toml": `${HOUSE_TOML}${jobs}`, ".gitattributes": "* -text\n" });
  git(root, env, "init", "-q");
  git(root, env, "add", "house.toml", ".gitattributes");
  git(root, env, "commit", "-q", "-m", "plant");
  return { root, env, house: () => loadHouse(root) };
}

/**
 * makeHouse, then finished the way a real house is: init plants every missing file (planted.json included) and the
 * projections are compiled, so doctor --quick, which tick runs, finds nothing to report.
 * @param {string} dir  a temp directory
 * @param {string} jobs  TOML text appended after [house]
 */
export function plantedHouse(dir, jobs) {
  const made = makeHouse(dir, jobs);
  for (const args of [["init", made.root], ["compile"]]) {
    const result = lampstand(args, { cwd: made.root, env: made.env });
    if (result.status !== 0) throw new Error(`lampstand ${args.join(" ")}: ${result.stdout}${result.stderr}`);
  }
  return made;
}

/**
 * Runs the CLI to completion.
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, input?: string }} options
 */
export function lampstand(args, options) {
  const result = spawnSync(NODE, [BIN, ...args], { ...options, encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Starts the CLI without waiting.
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
export function lampstandAsync(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** The one JSON object a --json run prints. @param {string} stdout */
export function envelope(stdout) {
  const lines = stdout.trimEnd().split("\n");
  if (lines.length !== 1) throw new Error(`--json printed ${lines.length} lines: ${stdout.slice(0, 500)}`);
  return JSON.parse(lines[0]);
}

/**
 * A copy of `env` with `dir` first on PATH, whatever the variable's spelling.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} dir
 */
export function withPathFirst(env, dir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const separator = process.platform === "win32" ? ";" : ":";
  return { ...env, [key]: `${dir}${separator}${env[key] ?? ""}` };
}
