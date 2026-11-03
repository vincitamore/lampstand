// @ts-check
// Lock rows in house.db's job_locks: `job:<id>` keeps one run of a job at a time, `land` keeps one run at a time in
// the landing step (rename, git add, commit, verify), so no commit can carry another run's paths. A row whose
// process has ended is stale: the next taker removes it and marks the abandoned run failed.
import { hostname } from "node:os";

/** @typedef {import("../state/sqlite.js").Database} Database */
/** @typedef {{ run_id: string, pid: number, host: string, acquired_at: string }} LockHolder */

/** @param {number} pid */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * Takes lock `name` for `runId`. Returns null when taken, otherwise the live holder.
 * @param {Database} db
 * @param {string} name
 * @param {string} runId
 * @returns {LockHolder | null}
 */
export function tryLock(db, name, runId) {
  return db.transaction(() => {
    const held = /** @type {LockHolder | undefined} */ (
      /** @type {unknown} */ (db.get("SELECT run_id, pid, host, acquired_at FROM job_locks WHERE name = ?", name))
    );
    const now = new Date().toISOString();
    if (held) {
      // house.db is per machine, so a holder on another host can only be a copied database: it cannot be alive here.
      if (held.host === hostname() && processAlive(Number(held.pid))) return held;
      db.run("DELETE FROM job_locks WHERE name = ?", name);
      db.run(
        "UPDATE job_runs SET outcome = 'failed', finished_at = ?, detail = ? WHERE run_id = ? AND outcome IS NULL",
        now,
        `abandoned: process ${held.pid} on ${held.host} ended without finishing the run`,
        held.run_id,
      );
    }
    db.run("INSERT INTO job_locks (name, run_id, pid, host, acquired_at) VALUES (?, ?, ?, ?, ?)", name, runId, process.pid, hostname(), now);
    return null;
  });
}

/**
 * Waits for lock `name`, polling, until `timeoutMs` passes. True when taken.
 * @param {Database} db
 * @param {string} name
 * @param {string} runId
 * @param {number} timeoutMs
 */
export function waitLock(db, name, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    if (tryLock(db, name, runId) === null) return true;
    if (Date.now() >= deadline) return false;
    Atomics.wait(pause, 0, 0, 100);
  }
}

/**
 * @param {Database} db
 * @param {string} name
 * @param {string} runId
 */
export function unlock(db, name, runId) {
  db.run("DELETE FROM job_locks WHERE name = ? AND run_id = ?", name, runId);
}
