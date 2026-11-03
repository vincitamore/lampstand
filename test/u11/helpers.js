// @ts-check
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Registry, runCli } from "../../core/lib/cli.js";
import { initHouse } from "../../core/lib/init/init.js";
import { verbs } from "../../core/lib/rooms/verbs.js";
import { isolatedEnv } from "../u1/helpers.js";

/** @typedef {{ after(fn: () => void): void }} TestContext */

/** A planted house compiles, and a fake agora is a spawned shell; bun's default 5 s per test is too short for that. */
export const SLOW = { timeout: 60_000 };

/** A fresh real-path temp directory removed when the test ends. @param {TestContext} t */
export function tempDir(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-u11-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/**
 * An environment whose PATH is `<dir>/bin` alone, so the machine's own agora is out of reach, and whose home, OMP and
 * agora locations all lie under `dir`. The shell (ComSpec, SystemRoot) is kept so a `.cmd` stand-in can run.
 * @param {string} dir
 */
export function roomsEnv(dir) {
  const env = isolatedEnv(dir);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  delete env.Path;
  for (const name of ["PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "AGORA_CONFIG"]) delete env[name];
  Object.assign(env, {
    PATH: bin,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  });
  return env;
}

/**
 * Puts a stand-in agora in `<dir>/bin` that answers `agora schema --json` with `version` and refuses anything else, as
 * agora does an unknown option.
 * @param {string} dir
 * @param {string} version
 */
export function fakeAgora(dir, version) {
  const schema = JSON.stringify({ name: "agora", version });
  if (process.platform === "win32") {
    writeFileSync(join(dir, "bin", "agora.cmd"), `@echo off\r\nif not "%~1"=="schema" exit /b 2\r\necho ${schema}\r\n`);
  } else {
    const path = join(dir, "bin", "agora");
    writeFileSync(path, `#!/bin/sh\n[ "$1" = schema ] || exit 2\nprintf '%s\\n' '${schema}'\n`);
    chmodSync(path, 0o755);
  }
}

/**
 * A house planted by `lampstand init` (no lattice) under `dir/house`.
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} env
 */
export function plantHouse(dir, env) {
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
      lattice: false,
    },
    makeDefault: false,
    env,
    date: "2026-01-01",
  });
  return root;
}

/**
 * Runs the rooms verbs through the CLI contract in process; stdin is never read because every enable passes --yes.
 * @param {string[]} args
 * @param {{ env: NodeJS.ProcessEnv, cwd: string }} options
 */
export async function lampstand(args, options) {
  let stdout = "";
  let stderr = "";
  const status = await runCli(new Registry().register(...verbs), args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    env: options.env,
    cwd: options.cwd,
  });
  return { status, stdout, stderr };
}

/** @param {string} stdout */
export function envelope(stdout) {
  const lines = stdout.trimEnd().split("\n");
  if (lines.length !== 1) throw new Error(`--json must print exactly one line, got ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
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

/** @param {string} root @param {string} rel */
export function read(root, rel) {
  return readFileSync(join(root, ...rel.split("/")));
}
