// @ts-check
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initHouse } from "../../core/lib/init/init.js";
import { CHECKS, runChecks } from "../../core/lib/doctor/checks.js";
import { gatherFacts } from "../../core/lib/doctor/facts.js";
import { isolatedEnv } from "../u1/helpers.js";

/** @typedef {{ after(fn: () => void): void }} TestContext */
/** @typedef {import("../../core/lib/doctor/util.js").Runner} Runner */
/** @typedef {import("../../core/lib/scheduler/os.js").Host} SchedulerHost */

/** A spawned CLI or a lattice compile can outlast bun's default 5 s on a loaded machine. */
export const SLOW = { timeout: 60_000 };

/** A fresh real-path temp directory removed when the test ends. @param {TestContext} t */
export function tempDir(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-u10-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** A file name PATH lookup finds as an executable on this platform. @param {string} name */
export function exe(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/**
 * An environment in which every per-user and host location lies under `dir` and PATH is `<dir>/bin`, holding empty
 * stand-ins for node and git: doctor only looks executables up, so a file is enough, and a test removes or adds one
 * to plant a fault.
 * @param {string} dir
 */
export function doctorEnv(dir) {
  const env = isolatedEnv(dir);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  delete env.Path;
  Object.assign(env, {
    PATH: bin,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    HERMES_HOME: join(dir, "hermes"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  });
  for (const name of [
    "PI_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "AGORA_CONFIG",
    "OneDrive",
    "OneDriveConsumer",
    "OneDriveCommercial",
    "HERMES_DATA_DIR_SUFFIX",
    "SLACK_ALLOWED_CHANNELS",
    "SLACK_FREE_RESPONSE_CHANNELS",
    "SLACK_REQUIRE_MENTION_CHANNELS",
    "SLACK_HOME_CHANNEL",
  ]) {
    delete env[name];
  }
  for (const name of ["node", "git"]) writeFileSync(join(bin, exe(name)), "");
  return env;
}

/**
 * Writes `files` (relative path to content) under `root`, creating parents.
 * @param {string} root
 * @param {Record<string, string>} files
 */
export function plant(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * A house planted by `lampstand init` (the lattice included) in a temp directory, with a doctorEnv around it.
 * @param {TestContext} t
 */
export function plantHouse(t) {
  const dir = tempDir(t);
  const env = doctorEnv(dir);
  const { root } = initHouse({
    dir: join(dir, "house"),
    answers: {
      name: "test-house",
      operator: "ana",
      coOwners: [],
      purpose: "The work is for the families our clinic serves.",
      charter: "rules",
      askFirst: ["Ask before pushing to any remote."],
      channelManners: "",
      lattice: true,
    },
    makeDefault: false,
    env,
    date: "2026-01-01",
  });
  return { dir, env, root };
}

/**
 * Rewrites part of a house file.
 * @param {string} root
 * @param {string} rel
 * @param {string | RegExp} from
 * @param {string} to
 */
export function edit(root, rel, from, to) {
  const path = join(root, ...rel.split("/"));
  const before = readFileSync(path, "utf8");
  const after = before.replace(from, to);
  if (after === before) throw new Error(`${rel} does not contain ${from}`);
  writeFileSync(path, after);
}

/** @type {Runner} */
const noHostProcess = (file) => {
  throw new Error(`doctor started ${file}, and this test expects no host process`);
};

/**
 * A scheduler host whose every OS command answers `status` with `stdout`.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} status
 * @param {string} [stdout]
 * @returns {SchedulerHost}
 */
export function schedulerHost(env, status, stdout = "") {
  return { platform: process.platform, home: String(env.HOME), uid: 0, env, scratch: tmpdir(), run: () => ({ status, stdout, stderr: "" }) };
}

/**
 * Gathers the facts and runs the checks, in process.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {{ quick?: boolean, run?: Runner, schedulerHost?: SchedulerHost }} [options]
 */
export function doctor(env, cwd, options = {}) {
  const quick = options.quick ?? false;
  const facts = gatherFacts({ env, cwd, quick, run: options.run ?? noHostProcess, schedulerHost: options.schedulerHost });
  return { facts, ...runChecks(facts, { quick }) };
}

/**
 * The exit class a code is declared with.
 * @param {string} code
 */
export function exitOf(code) {
  const check = CHECKS.find((candidate) => code in candidate.codes);
  if (!check) throw new Error(`no check declares ${code}`);
  return check.codes[code];
}

/** @param {{ findings: { code: string }[] }} report */
export function codes(report) {
  return report.findings.map((finding) => finding.code);
}
