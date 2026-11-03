// @ts-check
// A job's health is read from its runs in house.db. The latest run that did something decides REJECTED and
// NOT_LANDED; otherwise the job is OK when its latest `landed` run finished within stale_hours, else STALE (which is
// also where a failing or never-run job ends up). `skipped` runs never decide anything: another run was going.

/** @typedef {import("./jobs.js").Job} Job */
/** @typedef {import("../state/sqlite.js").Database} Database */
/** @typedef {"OK" | "STALE" | "NOT_LANDED" | "REJECTED"} Health */
/**
 * @typedef {{
 *   job: string,
 *   health: Health,
 *   last_outcome: string | null,
 *   last_run_at: string | null,
 *   last_landed_at: string | null,
 *   stale_hours: number,
 *   detail: string,
 * }} JobHealth
 */

/**
 * @param {Database} db
 * @param {Job} job
 * @param {number} now  epoch ms
 * @returns {JobHealth}
 */
export function jobHealth(db, job, now) {
  const last = db.get(
    "SELECT outcome, started_at, detail FROM job_runs WHERE job = ? AND outcome IS NOT NULL AND outcome <> 'skipped' ORDER BY id DESC LIMIT 1",
    job.id,
  );
  const landed = db.get("SELECT finished_at FROM job_runs WHERE job = ? AND outcome = 'landed' ORDER BY id DESC LIMIT 1", job.id);
  const lastOutcome = last ? String(last.outcome) : null;
  const landedAt = landed ? String(landed.finished_at) : null;
  /** @type {Health} */
  let health;
  if (lastOutcome === "rejected") health = "REJECTED";
  else if (lastOutcome === "not_landed") health = "NOT_LANDED";
  else if (landedAt !== null && now - Date.parse(landedAt) <= job.staleHours * 3_600_000) health = "OK";
  else health = "STALE";
  return {
    job: job.id,
    health,
    last_outcome: lastOutcome,
    last_run_at: last ? String(last.started_at) : null,
    last_landed_at: landedAt,
    stale_hours: job.staleHours,
    detail: last && health !== "OK" ? String(last.detail).split("\n")[0] : "",
  };
}
