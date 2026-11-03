// @ts-check
// Jobs are declared in house.toml as [jobs.<id>] tables, validated against schema/jobs.schema.json plus the checks
// that schema subset cannot state. A job's paths are house-relative with forward slashes: `outputs` are prefixes it
// may create files under, `mutates` the exact existing files it may replace.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOUSE_SCHEMA, HOUSE_SCHEMA_VERSION, parseHouseToml, validate } from "../config.js";
import { fail } from "../errors.js";
import { readText } from "../io.js";
import { parseToml } from "../parse/toml.js";
import { nextOccurrence, parseCron } from "./cron.js";

/** @typedef {import("../config.js").Schema} Schema */
/** @typedef {import("../config.js").HouseConfig} HouseConfig */
/** @typedef {import("./cron.js").Cron} Cron */
/** @typedef {{ kind: "every", ms: number, text: string } | { kind: "cron", cron: Cron, text: string }} Schedule */
/**
 * @typedef {{
 *   id: string,
 *   argv: string[],
 *   schedule: Schedule | null,
 *   staleHours: number,
 *   outputs: string[],
 *   mutates: string[],
 *   commit: boolean | "push",
 *   costCeilingUsd: number | null,
 *   env: string[],
 * }} Job
 */
/** @typedef {{ root: string, path: string, config: HouseConfig, jobs: Map<string, Job> }} House */

export const JOBS_SCHEMA = /** @type {Schema} */ (
  JSON.parse(readFileSync(new URL("../../../schema/jobs.schema.json", import.meta.url), "utf8"))
);

// house.schema.json does not yet name [jobs]; until it does, house.toml is validated with the jobs table added.
const HOUSE_WITH_JOBS = /** @type {Schema} */ (
  HOUSE_SCHEMA.properties?.jobs ? HOUSE_SCHEMA : { ...HOUSE_SCHEMA, properties: { ...HOUSE_SCHEMA.properties, jobs: JOBS_SCHEMA } }
);

export const JOB_ID = /^[a-z][a-z0-9-]*$/;

const UNIT_MS = /** @type {Record<string, number>} */ ({ m: 60_000, h: 3_600_000, d: 86_400_000 });

/**
 * A tick can fire a little early (timer coalescing, sleep); a job due within this margin counts as due, so a job
 * scheduled every 15 minutes does not slip to every 30.
 */
export const DUE_SLACK_MS = 60_000;

/**
 * Reads house.toml at `root` with its jobs.
 * @param {string} root
 * @returns {House}
 */
export function loadHouse(root) {
  const path = join(root, "house.toml");
  const text = readText(path);
  /** @type {Map<string, number>} */
  const lines = new Map();
  const data = parseToml(text, path, { lines });
  const head = data.house;
  const version = typeof head === "object" && head !== null && !Array.isArray(head) ? head.schema : undefined;
  // A newer house.schema is refused by config.js before anything else; delegating keeps that message in one place.
  if (typeof version === "number" && Number.isInteger(version) && version > HOUSE_SCHEMA_VERSION) parseHouseToml(text, path);
  validate(HOUSE_WITH_JOBS, data, path, lines);
  /** @type {Map<string, Job>} */
  const jobs = new Map();
  const declared = /** @type {Record<string, Record<string, any>>} */ (data.jobs ?? {});
  for (const [id, raw] of Object.entries(declared)) jobs.set(id, toJob(id, raw, path, lines));
  return { root, path, config: /** @type {HouseConfig} */ (/** @type {unknown} */ (data)), jobs };
}

/**
 * @param {string} id
 * @param {Record<string, any>} raw  already schema-valid
 * @param {string} path
 * @param {Map<string, number>} lines
 * @returns {Job}
 */
function toJob(id, raw, path, lines) {
  /** @param {string[]} at @param {string} reason */
  const refuse = (at, reason) =>
    fail("E_SCHEMA", `jobs.${[id, ...at].join(".")} ${reason}`, { path, line: lines.get(JSON.stringify(["jobs", id, ...at.slice(0, 1)])) ?? lines.get(JSON.stringify(["jobs", id])) });
  if (!JOB_ID.test(id)) throw refuse([], `is not a valid job id: use lowercase letters, digits and hyphens, starting with a letter`);
  if (raw.argv.length === 0) throw refuse(["argv"], "must name a program to run");
  const keys = ["every", "at", "cron"].filter((key) => raw[key] !== undefined);
  if (keys.length > 1) throw refuse([keys[1]], `cannot be combined with ${keys[0]}: a job has one schedule`);
  /** @type {Schedule | null} */
  let schedule = null;
  if (raw.every !== undefined) {
    const text = /** @type {string} */ (raw.every);
    schedule = { kind: "every", ms: Number(text.slice(0, -1)) * UNIT_MS[text.slice(-1)], text };
  } else if (raw.at !== undefined || raw.cron !== undefined) {
    const text = raw.at !== undefined ? `${Number(raw.at.slice(3))} ${Number(raw.at.slice(0, 2))} * * *` : raw.cron;
    try {
      schedule = { kind: "cron", cron: parseCron(text), text: raw.at !== undefined ? `at ${raw.at}` : text };
    } catch (error) {
      throw refuse([keys[0]], /** @type {Error} */ (error).message);
    }
  }
  const outputs = /** @type {string[]} */ (raw.outputs ?? []);
  const mutates = /** @type {string[]} */ (raw.mutates ?? []);
  for (const [key, list] of /** @type {const} */ ([["outputs", outputs], ["mutates", mutates]])) {
    list.forEach((entry, k) => {
      const reason = pathProblem(entry);
      if (reason) throw refuse([key, String(k)], `${JSON.stringify(entry)} ${reason}`);
    });
  }
  return {
    id,
    argv: raw.argv,
    schedule,
    staleHours: raw.stale_hours,
    outputs: outputs.map((entry) => entry.replace(/\/$/, "")),
    mutates,
    commit: raw.commit ?? false,
    costCeilingUsd: raw.cost_ceiling_usd ?? null,
    env: raw.env ?? [],
  };
}

/**
 * Why a declared or staged house-relative path is unusable, or null.
 * @param {string} rel
 */
export function pathProblem(rel) {
  const segments = rel.replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "must be a relative path without empty, . or .. segments";
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return "enters .git, which only git writes";
  return null;
}

/**
 * True when a staged path is one the job may land: an exact `mutates` entry or a path under an `outputs` prefix.
 * @param {Job} job
 * @param {string} rel
 */
export function mayLand(job, rel) {
  if (pathProblem(rel) !== null) return false;
  return job.mutates.includes(rel) || job.outputs.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

/**
 * Whether a scheduled job is due at `now`. `lastStart` is the start of the job's latest run (any trigger); `anchor`
 * stands in for it when the job has never run. However long the gap, a due job runs once: that is the catch-up.
 * @param {Job} job
 * @param {number | null} lastStart  epoch ms
 * @param {number} anchor  epoch ms
 * @param {number} now  epoch ms
 */
export function isDue(job, lastStart, anchor, now) {
  const schedule = job.schedule;
  if (!schedule) return false;
  if (schedule.kind === "every") return lastStart === null || now + DUE_SLACK_MS >= lastStart + schedule.ms;
  const next = nextOccurrence(schedule.cron, new Date(lastStart ?? anchor));
  return next !== null && next.getTime() <= now + DUE_SLACK_MS;
}
