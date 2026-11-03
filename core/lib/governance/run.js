// @ts-check
// `lampstand run <job>`: the only way a scheduled job writes into the house.
//
//   1. take the job's lock row (held by a live run: outcome `skipped`);
//   2. create a staging dir and run the job with HOUSE_RUN_OUT, HOUSE_ROOT and HOUSE_RUN_ID set, recording the hash
//      of every `mutates` file first (a non-zero exit: `failed`);
//   3. validate every staged path against `outputs` and `mutates`; one violation lands nothing (`rejected`);
//   4. land: a new file is published without ever replacing an existing one, a `mutates` file only if its live hash
//      still equals the hash recorded before the run; `git add` exactly the landed paths, commit only them, and
//      require `git show --name-only HEAD` to equal them (anything short of that: `not_landed`);
//   5. write the job_runs row.
//
// Nothing here runs `git status`: what to commit is known from the staging dir, and asking git what changed would
// pick up the user's own edits and other runs' files.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "../errors.js";
import { errorMessage } from "../io.js";
import { openStateDb } from "../state/db.js";
import { stateDirFor } from "../state/paths.js";
import { mayLand, pathProblem } from "./jobs.js";
import { tryLock, unlock, waitLock } from "./locks.js";
import { spawnResolved } from "./spawn.js";

/** @typedef {import("./jobs.js").Job} Job */
/** @typedef {import("./jobs.js").House} House */
/** @typedef {import("../state/sqlite.js").Database} Database */
/** @typedef {"landed" | "rejected" | "not_landed" | "failed" | "skipped"} Outcome */
/**
 * @typedef {{
 *   job: string,
 *   runId: string,
 *   outcome: Outcome,
 *   exitCode: number | null,
 *   landed: string[],
 *   commit: string | null,
 *   detail: string,
 *   log: string | null,
 * }} RunRecord
 */

export const OUTCOMES = /** @type {const} */ (["landed", "rejected", "not_landed", "failed", "skipped"]);

const LAMPSTAND_BIN = fileURLToPath(new URL("../../bin/lampstand.js", import.meta.url));

/** How long a run waits for another run of the same house to finish landing. */
const LAND_WAIT_MS = 30 * 60_000;

/** Variables a job inherits besides those it names in `env`: enough to start programs and find the user's files. */
const BASE_ENV = new Set([
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "USERNAME", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME",
  "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "LAMPSTAND_STATE_ROOT", "LAMPSTAND_CONFIG_ROOT",
]);

/** Link errors that mean "this filesystem pair cannot hard-link", as opposed to a real failure. */
const NO_LINK = new Set(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"]);

/**
 * Opens the house's state database.
 * @param {House} house
 * @param {NodeJS.ProcessEnv} env
 */
export function openHouseDb(house, env) {
  return openStateDb(stateDirFor(house.root, house.config.house.id, env).dir);
}

/**
 * Runs one job end to end and records it. Throws only for a job that is not declared or a state database that
 * cannot be opened; everything after the lock is an outcome.
 * @param {{ house: House, jobId: string, env: NodeJS.ProcessEnv, trigger?: "manual" | "tick" }} options
 * @returns {RunRecord}
 */
export function runJob({ house, jobId, env, trigger = "manual" }) {
  const job = house.jobs.get(jobId);
  if (!job) {
    const known = [...house.jobs.keys()].sort();
    throw fail("E_USAGE", `no job ${JSON.stringify(jobId)} in [jobs]${known.length ? `; declared: ${known.join(", ")}` : ""}`, {
      path: house.path,
    });
  }
  const state = openHouseDb(house, env);
  try {
    return runLocked(state.db, state.dir, house, job, env, trigger);
  } finally {
    state.db.close();
  }
}

/**
 * @param {Database} db
 * @param {string} stateDir
 * @param {House} house
 * @param {Job} job
 * @param {NodeJS.ProcessEnv} env
 * @param {"manual" | "tick"} trigger
 * @returns {RunRecord}
 */
function runLocked(db, stateDir, house, job, env, trigger) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const held = tryLock(db, `job:${job.id}`, runId);
  if (held) {
    const detail = `run ${held.run_id} (process ${held.pid}) of this job is still going`;
    db.run(
      "INSERT INTO job_runs (job, started_at, finished_at, outcome, detail, run_id, trigger) VALUES (?, ?, ?, 'skipped', ?, ?, ?)",
      job.id, startedAt, startedAt, detail, runId, trigger,
    );
    return { job: job.id, runId, outcome: "skipped", exitCode: null, landed: [], commit: null, detail, log: null };
  }
  db.run("INSERT INTO job_runs (job, started_at, run_id, trigger) VALUES (?, ?, ?, ?)", job.id, startedAt, runId, trigger);
  const staging = join(stateDir, "runs", runId);
  const log = join(stateDir, "logs", `${runId}.log`);
  /** @type {Omit<RunRecord, "job" | "runId" | "log">} */
  let result = { outcome: "failed", exitCode: null, landed: [], commit: null, detail: "" };
  try {
    result = execute(db, house, job, env, runId, staging, log);
  } catch (error) {
    result = { ...result, outcome: "failed", detail: `lampstand could not complete the run: ${errorMessage(error)}` };
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
    db.run(
      "UPDATE job_runs SET finished_at = ?, outcome = ?, exit_code = ?, landed = ?, commit_sha = ?, detail = ? WHERE run_id = ?",
      new Date().toISOString(), result.outcome, result.exitCode, JSON.stringify(result.landed), result.commit, result.detail, runId,
    );
    unlock(db, `job:${job.id}`, runId);
  }
  return { job: job.id, runId, log, ...result };
}

/**
 * @param {Database} db
 * @param {House} house
 * @param {Job} job
 * @param {NodeJS.ProcessEnv} env
 * @param {string} runId
 * @param {string} staging
 * @param {string} log
 * @returns {Omit<RunRecord, "job" | "runId" | "log">}
 */
function execute(db, house, job, env, runId, staging, log) {
  const out = join(staging, "out");
  mkdirSync(out, { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  /** @type {Map<string, string | null>} */
  const before = new Map(job.mutates.map((rel) => [rel, liveHash(livePath(house.root, rel))]));

  const exit = execJob(job, house.root, out, runId, env, log);
  const exitCode = typeof exit.status === "number" ? exit.status : null;
  const base = { exitCode, landed: /** @type {string[]} */ ([]), commit: null };
  if (exit.error) return { ...base, outcome: "failed", detail: `cannot start ${job.argv[0]}: ${exit.error.message}` };
  if (exit.status !== 0) {
    return { ...base, outcome: "failed", detail: `exited with ${exit.status ?? `signal ${exit.signal}`}; nothing landed; log: ${log}` };
  }

  const { files, problems } = walk(out);
  for (const rel of files) if (!mayLand(job, rel)) problems.push(`${rel}: ${pathProblem(rel) ?? "outside outputs and mutates"}`);
  if (problems.length > 0) {
    const shown = problems.slice(0, 20).join("\n");
    const more = problems.length > 20 ? `\n... and ${problems.length - 20} more` : "";
    return { ...base, outcome: "rejected", detail: `nothing landed; ${problems.length} staged path(s) refused:\n${shown}${more}` };
  }
  if (files.length === 0) return { ...base, outcome: "landed", detail: "the job staged nothing" };

  if (!waitLock(db, "land", runId, LAND_WAIT_MS)) {
    return { ...base, outcome: "not_landed", detail: "another run held the landing step too long; nothing landed" };
  }
  try {
    return { exitCode, ...land(house, job, env, runId, staging, out, files, before) };
  } finally {
    unlock(db, "land", runId);
  }
}

/**
 * @param {Job} job
 * @param {string} root
 * @param {string} out
 * @param {string} runId
 * @param {NodeJS.ProcessEnv} env
 * @param {string} log
 */
function execJob(job, root, out, runId, env, log) {
  // `lampstand` names this CLI under the runtime running it, so a job need not find it on PATH.
  const argv = job.argv[0] === "lampstand" ? [process.execPath, LAMPSTAND_BIN, ...job.argv.slice(1)] : job.argv;
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {};
  const named = new Set(job.env.map((name) => (process.platform === "win32" ? name.toUpperCase() : name)));
  for (const [key, value] of Object.entries(env)) {
    const name = process.platform === "win32" ? key.toUpperCase() : key;
    if (BASE_ENV.has(name) || named.has(name)) childEnv[key] = value;
  }
  childEnv.HOUSE_ROOT = root;
  childEnv.HOUSE_RUN_OUT = out;
  childEnv.HOUSE_RUN_ID = runId;
  if (job.costCeilingUsd !== null) childEnv.HOUSE_COST_CEILING_USD = String(job.costCeilingUsd);
  const fd = openSync(log, "a");
  try {
    return spawnResolved(argv[0], argv.slice(1), { cwd: root, env: childEnv, stdio: ["ignore", fd, fd], windowsHide: true });
  } catch (error) {
    return { status: null, signal: null, error: /** @type {Error} */ (error) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Every staged regular file as a house-relative path, sorted; anything else (a symlink, a device) is a problem.
 * @param {string} out
 */
function walk(out) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const problems = [];
  const pending = [""];
  while (pending.length > 0) {
    const rel = /** @type {string} */ (pending.pop());
    for (const entry of readdirSync(rel === "" ? out : join(out, ...rel.split("/")), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) files.push(child);
      else problems.push(`${child}: not a regular file`);
    }
  }
  files.sort();
  return { files, problems };
}

/** @param {string} root @param {string} rel */
function livePath(root, rel) {
  return join(root, ...rel.split("/"));
}

/**
 * sha256 of the file's bytes, null when absent, or a marker when something other than a file sits there.
 * @param {string} path
 * @returns {string | null}
 */
function liveHash(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return `not-a-file:${stat.mode}`;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
}

/** @param {string} a @param {string} b */
function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Puts `source` at `target` only if nothing is there: a hard link is created atomically and fails on an existing
 * name, so a file someone else created meanwhile is never replaced. Across filesystems the bytes are first copied
 * beside the target, then linked into place.
 * @param {string} source
 * @param {string} target
 * @param {string} runId
 */
function publish(source, target, runId) {
  try {
    linkSync(source, target);
    return;
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "";
    if (!NO_LINK.has(code)) throw error;
  }
  const temp = join(dirname(target), `.lampstand-${runId}-${basename(target)}`);
  copyFileSync(source, temp, constants.COPYFILE_EXCL);
  try {
    linkSync(temp, target);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "";
    if (!NO_LINK.has(code)) throw error;
    // A filesystem without hard links: still never replaces, though a reader may see the copy while it is written.
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Replaces `target` with `source` in one rename; across filesystems via a copy beside the target.
 * @param {string} source
 * @param {string} target
 * @param {string} runId
 */
function replace(source, target, runId) {
  try {
    renameSync(source, target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EXDEV") throw error;
    const temp = join(dirname(target), `.lampstand-${runId}-${basename(target)}`);
    copyFileSync(source, temp, constants.COPYFILE_EXCL);
    try {
      renameSync(temp, target);
    } catch (inner) {
      rmSync(temp, { force: true });
      throw inner;
    }
  }
}

/**
 * Lands the staged files, then commits them when the job asks to. Runs under the house's `land` lock.
 * @param {House} house
 * @param {Job} job
 * @param {NodeJS.ProcessEnv} env
 * @param {string} runId
 * @param {string} staging
 * @param {string} out
 * @param {string[]} files
 * @param {Map<string, string | null>} before
 * @returns {Omit<RunRecord, "job" | "runId" | "log" | "exitCode">}
 */
function land(house, job, env, runId, staging, out, files, before) {
  /** @type {string[]} */
  const landed = [];
  /** @type {string[]} */
  const conflicts = [];
  /** @type {Set<string>} */
  const madeDirs = new Set();
  for (const rel of files) {
    const staged = join(out, ...rel.split("/"));
    const target = livePath(house.root, rel);
    try {
      if (job.mutates.includes(rel)) {
        const now = liveHash(target);
        if (now !== before.get(rel)) {
          conflicts.push(`${rel}: changed in the house during the run; left as it is`);
          continue;
        }
        if (now !== null) {
          if (createHash("sha256").update(readFileSync(staged)).digest("hex") === now) continue;
          replace(staged, target, runId);
          landed.push(rel);
          continue;
        }
      }
      const parent = dirname(target);
      if (!madeDirs.has(parent)) {
        mkdirSync(parent, { recursive: true });
        madeDirs.add(parent);
      }
      publish(staged, target, runId);
      landed.push(rel);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === "EEXIST" && sameBytes(staged, target)) continue;
      conflicts.push(code === "EEXIST" ? `${rel}: already exists in the house; not replaced` : `${rel}: ${errorMessage(error)}`);
    }
  }

  /** @type {string | null} */
  let commit = null;
  /** @type {string[]} */
  const problems = [...conflicts];
  if (job.commit !== false && landed.length > 0) {
    const committed = commitPaths(house.root, landed, job, env, runId, staging);
    commit = committed.commit;
    if (committed.problem) problems.push(committed.problem);
  }
  if (problems.length === 0) {
    return { outcome: "landed", landed, commit, detail: `${landed.length} path(s) landed${commit ? ` in ${commit}` : ""}` };
  }
  return { outcome: "not_landed", landed, commit, detail: problems.join("\n") };
}

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} args
 */
function git(root, env, args) {
  /** @type {NodeJS.ProcessEnv} */
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  try {
    const result = spawnResolved("git", args, { cwd: root, env: gitEnv, encoding: "utf8", maxBuffer: 1 << 30, windowsHide: true });
    const stderr = String(result.stderr ?? "").trim();
    return { ok: result.status === 0, stdout: String(result.stdout ?? ""), stderr: result.error ? result.error.message : stderr };
  } catch (error) {
    return { ok: false, stdout: "", stderr: errorMessage(error) };
  }
}

/**
 * `git add` exactly `paths`, commit only them (the user's own staged changes stay staged and out of the commit),
 * and verify the commit's name list equals them.
 * @param {string} root
 * @param {string[]} paths  sorted house-relative paths
 * @param {Job} job
 * @param {NodeJS.ProcessEnv} env
 * @param {string} runId
 * @param {string} staging
 * @returns {{ commit: string | null, problem: string | null }}
 */
function commitPaths(root, paths, job, env, runId, staging) {
  const where = git(root, env, ["rev-parse", "--show-prefix"]);
  if (!where.ok) return { commit: null, problem: `the house is not a git work tree, so nothing was committed: ${where.stderr}` };
  const prefix = where.stdout.trim();
  const head = git(root, env, ["rev-parse", "-q", "--verify", "HEAD"]);
  const previous = head.ok ? head.stdout.trim() : null;
  // A pathspec file keeps 30,000 paths off the command line; literal pathspecs keep `*` or `:` in a name a name.
  const list = join(staging, "pathspec");
  writeFileSync(list, paths.join("\0"));
  const fromFile = [`--pathspec-from-file=${list}`, "--pathspec-file-nul"];
  const added = git(root, env, ["--literal-pathspecs", "add", ...fromFile]);
  if (!added.ok) return { commit: null, problem: `git add refused the landed paths: ${added.stderr}` };
  const message = [`lampstand run ${job.id}`, `Lampstand-Run: ${runId}`];
  const committed = git(root, env, ["--literal-pathspecs", "commit", "--only", "-q", "-m", message[0], "-m", message[1], ...fromFile]);
  if (!committed.ok) {
    const why = committed.stderr || committed.stdout.trim() || "no message";
    return { commit: null, problem: `git commit was refused (a hook or the repository declined it): ${why}` };
  }
  const now = git(root, env, ["rev-parse", "-q", "--verify", "HEAD"]);
  const sha = now.ok ? now.stdout.trim() : null;
  if (sha === null || sha === previous) return { commit: null, problem: "git commit reported success but HEAD did not move" };
  const shown = git(root, env, ["show", "--name-only", "--format=", "-z", sha]);
  if (!shown.ok) return { commit: sha, problem: `cannot read back commit ${sha}: ${shown.stderr}` };
  const names = shown.stdout.split("\0").filter(Boolean).map((name) => (name.startsWith(prefix) ? name.slice(prefix.length) : `/${name}`));
  names.sort();
  if (names.length !== paths.length || names.some((name, k) => name !== paths[k])) {
    const want = new Set(paths);
    const got = new Set(names);
    const extra = names.filter((name) => !want.has(name)).slice(0, 5);
    const missing = paths.filter((name) => !got.has(name)).slice(0, 5);
    return {
      commit: sha,
      problem: `commit ${sha} carries ${names.length} path(s), not the ${paths.length} that landed (extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
    };
  }
  if (job.commit === "push") {
    const pushed = git(root, env, ["push"]);
    if (!pushed.ok) return { commit: sha, problem: `committed ${sha} but git push failed: ${pushed.stderr}` };
  }
  return { commit: sha, problem: null };
}
