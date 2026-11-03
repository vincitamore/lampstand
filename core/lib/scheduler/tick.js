// @ts-check
// `lampstand tick`: what the one OS entry per house runs every TICK_MINUTES. It runs each due job once, however long
// the machine slept (the catch-up), then `doctor --quick` when a doctor module is installed. It is silent on
// success. On failure it writes one capture under inbox/captures/, and a failure identical to the previous tick's
// (the same jobs with the same outcomes) writes nothing more, so a broken job does not fill the inbox.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, errorMessage } from "../io.js";
import { isDue } from "../governance/jobs.js";
import { openHouseDb, runJob } from "../governance/run.js";

/** @typedef {import("../governance/jobs.js").House} House */
/** @typedef {import("../governance/run.js").RunRecord} RunRecord */
/** @typedef {(context: { root: string, env: NodeJS.ProcessEnv }) => Promise<{ ok: boolean, detail: string }>} DoctorRunner */
/**
 * @typedef {{
 *   active: boolean,
 *   ran: RunRecord[],
 *   doctor: "ok" | "failed" | "absent",
 *   failures: string[],
 *   capture: string | null,
 * }} TickResult
 */

export const TICK_MINUTES = 15;

const FAILING = new Set(["failed", "rejected", "not_landed"]);

/**
 * The installed doctor verb as a runner, or null when no doctor module exists.
 * @returns {Promise<DoctorRunner | null>}
 */
export async function findDoctor() {
  const url = new URL("../doctor/verbs.js", import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  const module = await import(url.href);
  /** @type {import("../cli.js").Verb | undefined} */
  const verb = (module.verbs ?? []).find((/** @type {{ name: string }} */ candidate) => candidate.name === "doctor");
  if (!verb) return null;
  return async ({ root, env }) => {
    const result = await verb.run({ args: [], flags: { quick: true }, json: true, env: { ...env, HOUSE_ROOT: root }, cwd: root });
    const ok = result.ok !== false && (result.exit ?? 0) === 0;
    return { ok, detail: ok ? "" : String(result.text ?? "").split("\n")[0] };
  };
}

/**
 * @param {{ house: House, env: NodeJS.ProcessEnv, doctor?: DoctorRunner | null }} options
 *   `doctor` overrides discovery: null means no doctor module.
 * @returns {Promise<TickResult>}
 */
export async function tick({ house, env, doctor }) {
  if (house.config.modules?.scheduler !== true) return { active: false, ran: [], doctor: "absent", failures: [], capture: null };
  const now = Date.now();
  /** @type {RunRecord[]} */
  const ran = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const signature = [];

  const state = openHouseDb(house, env);
  /** @type {string[]} */
  const due = [];
  try {
    const lastTick = state.db.get("SELECT value FROM scheduler_state WHERE key = 'last_tick'");
    const anchor = lastTick ? Date.parse(String(lastTick.value)) : now - TICK_MINUTES * 60_000;
    for (const job of [...house.jobs.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const last = state.db.get("SELECT started_at FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT 1", job.id);
      if (isDue(job, last ? Date.parse(String(last.started_at)) : null, anchor, now)) due.push(job.id);
    }
  } finally {
    state.db.close();
  }

  for (const id of due) {
    try {
      const record = runJob({ house, jobId: id, env, trigger: "tick" });
      ran.push(record);
      if (FAILING.has(record.outcome)) {
        failures.push(`job ${id}: ${record.outcome}: ${record.detail.split("\n")[0]}${record.log ? ` (log: ${record.log})` : ""}`);
        signature.push(`job ${id}: ${record.outcome}`);
      }
    } catch (error) {
      failures.push(`job ${id}: could not run: ${errorMessage(error)}`);
      signature.push(`job ${id}: could not run`);
    }
  }

  /** @type {TickResult["doctor"]} */
  let doctorState = "absent";
  const runner = doctor === undefined ? await findDoctor() : doctor;
  if (runner) {
    let verdict;
    try {
      verdict = await runner({ root: house.root, env });
    } catch (error) {
      verdict = { ok: false, detail: errorMessage(error) };
    }
    doctorState = verdict.ok ? "ok" : "failed";
    if (!verdict.ok) {
      failures.push(`doctor --quick: ${verdict.detail || "reported problems"}`);
      signature.push("doctor --quick");
    }
  }

  let capture = null;
  const after = openHouseDb(house, env);
  try {
    const set = "INSERT INTO scheduler_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
    after.db.run(set, "last_tick", new Date(now).toISOString());
    if (failures.length === 0) {
      after.db.run("DELETE FROM scheduler_state WHERE key = 'last_failure'");
    } else {
      const digest = createHash("sha256").update(signature.join("\n"), "utf8").digest("hex");
      const previous = after.db.get("SELECT value FROM scheduler_state WHERE key = 'last_failure'");
      if (!previous || previous.value !== digest) {
        capture = writeCapture(house.root, failures, new Date(now));
        after.db.run(set, "last_failure", digest);
      }
    }
  } finally {
    after.db.close();
  }
  return { active: true, ran, doctor: doctorState, failures, capture };
}

/**
 * @param {string} root
 * @param {string[]} failures
 * @param {Date} at
 * @returns {string} the capture's house-relative path
 */
function writeCapture(root, failures, at) {
  const dir = join(root, "inbox", "captures");
  mkdirSync(dir, { recursive: true });
  const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  let name = `${stamp}-tick-failure.md`;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${stamp}-tick-failure-${n}.md`;
  const body = [
    "---",
    "kind: capture",
    `created: ${at.toISOString().slice(0, 10)}`,
    "source: lampstand tick",
    "---",
    "",
    `# lampstand tick: ${failures.length} failure${failures.length === 1 ? "" : "s"}`,
    "",
    ...failures.map((line) => `- ${line}`),
    "",
    "The same failure on later ticks adds no further capture; `lampstand run --status` shows each job's health.",
    "",
  ].join("\n");
  atomicWrite(join(dir, name), body);
  return `inbox/captures/${name}`;
}
