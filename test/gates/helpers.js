// @ts-check
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** @typedef {{ after(fn: () => void): void }} TestContext */

/**
 * A fresh real-path temp directory removed when the test ends.
 * @param {TestContext} t
 */
export function tempDir(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-gates-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/**
 * Writes `files` (relative path to content) under `root`, creating parents.
 * @param {string} root
 * @param {Record<string, string | Buffer>} files
 */
export function plant(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * A git repository at a new temp directory holding `files` (untracked is enough: the gates list files with
 * `git ls-files --cached --others --exclude-standard`), plus the real release allowlist the shipped-file gates read.
 * @param {TestContext} t
 * @param {Record<string, string | Buffer>} files
 */
export function repo(t, files) {
  const root = join(tempDir(t), "repo");
  mkdirSync(root);
  const init = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
  plant(root, { "dev/release-allowlist.json": readFileSync(join(REPO, "dev", "release-allowlist.json")), ...files });
  return root;
}

/**
 * Runs `dev/<script>` from this checkout with `args`, in an environment whose lampstand roots are temp directories.
 * @param {string} script
 * @param {string[]} args
 * @param {string} scratch  a temp directory for the roots
 */
export function gate(script, args, scratch) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, LAMPSTAND_STATE_ROOT: join(scratch, "state-root"), LAMPSTAND_CONFIG_ROOT: join(scratch, "config-root") };
  delete env.HOUSE_ROOT;
  const result = spawnSync(process.execPath, [join(REPO, "dev", script), ...args], { encoding: "utf8", env, cwd: scratch });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: `${result.stdout}${result.stderr}` };
}
