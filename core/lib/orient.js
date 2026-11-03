// @ts-check
// The dynamic orientation a session starts with: counts of org items per kind and status, then only the problems
// (a schema newer than this code, generated projections whose input hash no longer matches the house, and job
// health STALE / NOT_LANDED / REJECTED). It is read-only: house.db is consulted only when it already exists, and is
// never created or migrated from here. The text is held to the dynamic-orientation budget; when it would run over, it
// drops whole lines from the end and says how many it left out.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capOf, MANIFEST_PATH, chars } from "./constitution/budgets.js";
import { inputHash, readInputs } from "./constitution/house.js";
import { isLampstandError } from "./errors.js";
import { jobHealth } from "./governance/health.js";
import { scanItems, statusOf } from "./org/items.js";
import { buildSchema, orgSchemaFrom, readHouseToml } from "./org/schema.js";
import { STATE_SCHEMA_VERSION } from "./state/db.js";
import { stateDirFor } from "./state/paths.js";
import { Database } from "./state/sqlite.js";

/** @typedef {import("./org/schema.js").HouseToml} HouseToml */
/** @typedef {"SCHEMA_NEWER" | "HOUSE_TOML" | "STALE_PROJECTION" | "STALE" | "NOT_LANDED" | "REJECTED"} ProblemCode */
/** @typedef {{ code: ProblemCode, subject: string, message: string }} Problem */
/** @typedef {Record<string, Record<string, number>>} Counts */
/**
 * @typedef {{
 *   counts: Counts,
 *   problems: Problem[],
 *   lines: string[],
 *   profile: "lean" | "standard" | "large",
 *   cap: number,
 * }} Orientation
 */

/** The status bucket for item files whose frontmatter does not parse or carries no usable status. */
export const UNPARSED = "(unparsed)";
export const NO_STATUS = "(no status)";

/**
 * Gathers the orientation of the house at `root`.
 * @param {string} root
 * @param {{ env?: NodeJS.ProcessEnv, now?: number }} [options]
 * @returns {Orientation}
 */
export function orient(root, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  /** @type {Problem[]} */
  const problems = [];

  /** @type {HouseToml | null} */
  let house = null;
  try {
    house = readHouseToml(root);
  } catch (error) {
    if (!isLampstandError(error)) throw error;
    problems.push({ code: error.code === "E_SCHEMA_NEWER" ? "SCHEMA_NEWER" : "HOUSE_TOML", subject: "house.toml", message: error.message });
  }

  let schema;
  try {
    schema = house ? orgSchemaFrom(house) : buildSchema({}, join(root, "house.toml"));
  } catch (error) {
    if (!isLampstandError(error)) throw error;
    problems.push({ code: "HOUSE_TOML", subject: "house.toml [org]", message: error.message });
    schema = buildSchema({}, join(root, "house.toml"));
  }

  /** @type {Counts} */
  const counts = {};
  for (const item of scanItems(root, schema)) {
    const status = item.error ? UNPARSED : statusOf(item) ?? NO_STATUS;
    const perKind = (counts[item.kind.name] ??= {});
    perKind[status] = (perKind[status] ?? 0) + 1;
  }

  problems.push(...projectionProblems(root));
  if (house) problems.push(...jobProblems(root, house, env, now));

  const budget = /** @type {{ profile?: unknown } | undefined} */ (house?.data.budget);
  const profile = budget?.profile === "lean" || budget?.profile === "large" ? budget.profile : "standard";
  const lines = [...countLines(counts, schema), ...problems.map((problem) => `${problem.code} ${problem.subject}: ${problem.message}`)];
  const surfaces = /** @type {Record<string, unknown> | undefined} */ (house?.data.surfaces);
  return { counts, problems, lines, profile, cap: capOf("dynamic-orientation", profile, surfaces ?? null) };
}

/**
 * One line per kind that has items, statuses in schema order, then any status outside it.
 * @param {Counts} counts
 * @param {import("./org/schema.js").OrgSchema} schema
 */
function countLines(counts, schema) {
  const lines = [];
  for (const kind of schema.kinds.values()) {
    const perKind = counts[kind.name];
    if (!perKind) continue;
    const total = Object.values(perKind).reduce((sum, n) => sum + n, 0);
    const order = [...kind.statuses, ...Object.keys(perKind).filter((status) => !kind.statuses.includes(status)).sort()];
    const parts = order.filter((status) => perKind[status]).map((status) => `${status} ${perKind[status]}`);
    lines.push(`${kind.name} ${total}: ${parts.join(", ")}`);
  }
  return lines.length === 0 ? ["org: no items"] : lines;
}

/**
 * A stale projection: the committed manifest's input hash no longer equals the hash of the house's inputs.
 * @param {string} root
 * @returns {Problem[]}
 */
function projectionProblems(root) {
  const path = join(root, ...MANIFEST_PATH.split("/"));
  if (!existsSync(path)) return [];
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(path, "utf8"))["input-hash"];
  } catch {
    return [{ code: "STALE_PROJECTION", subject: MANIFEST_PATH, message: "is not JSON; run lampstand compile" }];
  }
  let current;
  try {
    current = inputHash(readInputs(root));
  } catch (error) {
    if (!isLampstandError(error)) throw error;
    return [{ code: "STALE_PROJECTION", subject: MANIFEST_PATH, message: `inputs cannot be read: ${error.message}` }];
  }
  if (recorded === current) return [];
  const was = typeof recorded === "string" ? recorded.slice(0, 12) : "missing";
  return [{
    code: "STALE_PROJECTION",
    subject: ".house/generated",
    message: `built from input-hash ${was}, the house is now ${current.slice(0, 12)}; run lampstand compile`,
  }];
}

/**
 * Job health from house.db's job_runs, for the jobs house.toml declares; nothing when house.db or the table does not
 * exist yet.
 * @param {string} root
 * @param {HouseToml} house
 * @param {NodeJS.ProcessEnv} env
 * @param {number} now
 * @returns {Problem[]}
 */
function jobProblems(root, house, env, now) {
  const head = /** @type {{ id?: unknown } | undefined} */ (house.data.house);
  const declared = /** @type {Record<string, { stale_hours?: unknown }> | undefined} */ (house.data.jobs);
  if (typeof head?.id !== "string" || !declared) return [];
  let dbPath;
  try {
    dbPath = join(stateDirFor(root, head.id, env).dir, "house.db");
  } catch (error) {
    if (!isLampstandError(error)) throw error;
    return [{ code: "HOUSE_TOML", subject: "state directory", message: error.message }];
  }
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    const hasTable = (/** @type {string} */ name) => db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", name) !== undefined;
    if (hasTable("meta")) {
      const version = Number(db.get("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? 0);
      if (version > STATE_SCHEMA_VERSION) {
        return [{ code: "SCHEMA_NEWER", subject: "house.db", message: `schema version ${version} is newer than this lampstand understands (${STATE_SCHEMA_VERSION}); upgrade lampstand` }];
      }
    }
    if (!hasTable("job_runs")) return [];
    /** @type {Problem[]} */
    const out = [];
    for (const id of Object.keys(declared).sort()) {
      const staleHours = declared[id]?.stale_hours;
      if (typeof staleHours !== "number") continue;
      const job = /** @type {import("./governance/jobs.js").Job} */ (/** @type {unknown} */ ({ id, staleHours }));
      const health = jobHealth(db, job, now);
      if (health.health === "OK") continue;
      const when = health.last_landed_at ? `last landed ${health.last_landed_at}` : "never landed";
      out.push({
        code: health.health,
        subject: `job ${id}`,
        message: `${when}; stale after ${staleHours}h${health.detail ? `; ${health.detail}` : ""}`,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Joins `lines` within `cap` characters (code points). Over the cap, whole lines are dropped from the end and a last
 * line says how many were left out; that line is counted inside the cap.
 * @param {string[]} lines
 * @param {number} cap
 * @returns {{ text: string, omitted: number }}
 */
export function capLines(lines, cap) {
  const all = lines.join("\n");
  if (chars(all) <= cap) return { text: all, omitted: 0 };
  const note = (/** @type {number} */ n) => `(${n} more line${n === 1 ? "" : "s"} left out; run lampstand status for all of them)`;
  let kept = 0;
  let size = 0;
  for (; kept < lines.length; kept++) {
    const next = size + chars(lines[kept]) + 1;
    if (next + chars(note(lines.length - kept - 1)) > cap) break;
    size = next;
  }
  const omitted = lines.length - kept;
  return { text: [...lines.slice(0, kept), note(omitted)].join("\n"), omitted };
}
