// @ts-check
// The dynamic orientation a session starts with: what needs attention by name (open tasks, overdue first; open
// decisions waiting for a ruling; reminders due), how many changes are not yet committed, the problems (a schema
// newer than this code, generated projections whose input hash no longer matches the house, and job health STALE /
// NOT_LANDED / REJECTED), and one line counting the other open items. It is read-only: house.db is consulted only
// when it already exists, and is never created or migrated from here. The text is held to the dynamic-orientation
// budget; when it would run over, it drops whole lines from the end and says how many it left out, so the lines
// stand in order of importance.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capOf, MANIFEST_PATH, chars } from "./constitution/budgets.js";
import { inputHash, readInputs } from "./constitution/house.js";
import { isLampstandError } from "./errors.js";
import { uncommittedPaths } from "./gate.js";
import { jobHealth } from "./governance/health.js";
import { scanItems, statusOf, stemOfItem, titleOf } from "./org/items.js";
import { localDate } from "./org/markdown.js";
import { buildSchema, fieldName, isTerminal, orgSchemaFrom, readHouseToml } from "./org/schema.js";
import { STATE_SCHEMA_VERSION } from "./state/db.js";
import { stateDirFor } from "./state/paths.js";
import { Database } from "./state/sqlite.js";

/** @typedef {import("./org/schema.js").HouseToml} HouseToml */
/** @typedef {import("./org/schema.js").OrgSchema} OrgSchema */
/** @typedef {import("./org/items.js").ItemFile} ItemFile */
/** @typedef {"SCHEMA_NEWER" | "HOUSE_TOML" | "STALE_PROJECTION" | "STALE" | "NOT_LANDED" | "REJECTED"} ProblemCode */
/** @typedef {{ code: ProblemCode, subject: string, message: string }} Problem */
/** @typedef {Record<string, Record<string, number>>} Counts */
/** @typedef {{ id: string, title: string, status: string, due: string | null, overdue: boolean }} Named */
/**
 * @typedef {{ tasks: Named[], decisions: Named[], reminders: Named[] }} Attention
 *   Every open task (overdue first, then by due date), every open decision, and every open reminder due today or
 *   before; the text names the first few of each.
 * @typedef {{
 *   counts: Counts,
 *   problems: Problem[],
 *   attention: Attention,
 *   uncommitted: number | null,
 *   lines: string[],
 *   countLines: string[],
 *   profile: "lean" | "standard" | "large",
 *   cap: number,
 * }} Orientation
 *   `lines` is the orientation; `countLines` the per-kind, per-status counts `lampstand status` leads with.
 *   `uncommitted` is null when git cannot answer.
 */

/** The status bucket for item files whose frontmatter does not parse or carries no usable status. */
export const UNPARSED = "(unparsed)";
export const NO_STATUS = "(no status)";

/** How many of each kind the orientation names; the rest are counted. */
export const NAMED = Object.freeze({ tasks: 8, decisions: 5, reminders: 5 });

/** The first line of an empty house's orientation. */
export const NOTHING_OPEN = "No open tasks, decisions or reminders yet.";

/**
 * Gathers the orientation of the house at `root`.
 * @param {string} root
 * @param {{ env?: NodeJS.ProcessEnv, now?: number, today?: string }} [options]  `today` (YYYY-MM-DD) defaults to the
 *   local date of `now`
 * @returns {Orientation}
 */
export function orient(root, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const today = options.today ?? localDate(new Date(now));
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
  const items = scanItems(root, schema);
  for (const item of items) {
    const status = item.error ? UNPARSED : statusOf(item) ?? NO_STATUS;
    const perKind = (counts[item.kind.name] ??= {});
    perKind[status] = (perKind[status] ?? 0) + 1;
  }
  const attention = attentionOf(items, schema, today);

  problems.push(...projectionProblems(root));
  if (house) problems.push(...jobProblems(root, house, env, now));

  const changed = uncommittedPaths(root);
  const uncommitted = changed === null ? null : changed.length;

  const budget = /** @type {{ profile?: unknown } | undefined} */ (house?.data.budget);
  const profile = budget?.profile === "lean" || budget?.profile === "large" ? budget.profile : "standard";
  const lines = [
    ...attentionLines(attention),
    ...(uncommitted ? [`${uncommitted} change${uncommitted === 1 ? "" : "s"} in the house not yet committed.`] : []),
    ...problems.map((problem) => `${problem.code} ${problem.subject}: ${problem.message}`),
    ...otherLines(counts, schema),
  ];
  const surfaces = /** @type {Record<string, unknown> | undefined} */ (house?.data.surfaces);
  return {
    counts,
    problems,
    attention,
    uncommitted,
    lines,
    countLines: countLines(counts, schema),
    profile,
    cap: capOf("dynamic-orientation", profile, surfaces ?? null),
  };
}

/** A title held to one short line. @param {string} title */
function short(title) {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77).trimEnd()}...` : flat;
}

/**
 * The open items of the three kinds a session acts on, each with its title.
 * @param {ItemFile[]} items
 * @param {OrgSchema} schema
 * @param {string} today
 * @returns {Attention}
 */
function attentionOf(items, schema, today) {
  /** @param {string} kindName @returns {Named[]} */
  const open = (kindName) =>
    items
      .filter((item) => item.kind.name === kindName && !item.error)
      .flatMap((item) => {
        const status = statusOf(item);
        if (status === undefined || isTerminal(item.kind, status)) return [];
        const value = item.frontmatter?.[fieldName(item.kind, "due")];
        const due = typeof value === "string" ? value : null;
        return [{ id: stemOfItem(item), title: short(titleOf(item, schema) ?? stemOfItem(item)), status, due, overdue: due !== null && due < today }];
      });
  /** @param {Named} a @param {Named} b */
  const byDue = (a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.id.localeCompare(b.id);
  const tasks = open("task").sort((a, b) => Number(b.overdue) - Number(a.overdue) || byDue(a, b));
  const decisions = open("decision").sort(byDue);
  const reminders = open("reminder").filter((item) => item.due !== null && item.due <= today).sort(byDue);
  return { tasks, decisions, reminders };
}

/**
 * Up to `limit` bullets, then one counting the rest and naming the verb that lists them all.
 * @param {Named[]} list
 * @param {number} limit
 * @param {(item: Named) => string} describe
 * @param {string} verb
 */
function bullets(list, limit, describe, verb) {
  return [...list.slice(0, limit).map((item) => `- ${describe(item)}`), ...(list.length > limit ? [`- and ${list.length - limit} more (${verb})`] : [])];
}

/** @param {Named} task */
function describeTask(task) {
  const notes = [...(task.status === "open" ? [] : [task.status]), ...(task.due ? [`due ${task.due}${task.overdue ? ", overdue" : ""}`] : [])];
  return `${task.title}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

/** @param {Attention} attention */
function attentionLines(attention) {
  const { tasks, decisions, reminders } = attention;
  if (tasks.length + decisions.length + reminders.length === 0) return [NOTHING_OPEN];
  const lines = [];
  if (tasks.length > 0) {
    const overdue = tasks.filter((task) => task.overdue).length;
    lines.push(`Open tasks (${tasks.length}${overdue > 0 ? `, ${overdue} overdue` : ""}):`, ...bullets(tasks, NAMED.tasks, describeTask, "lampstand task list"));
  } else {
    lines.push("No open tasks.");
  }
  if (decisions.length > 0) {
    lines.push(
      `Decisions waiting for the operator's ruling (${decisions.length}):`,
      ...bullets(decisions, NAMED.decisions, (decision) => decision.title, "lampstand inbox list --kind decision"),
    );
  }
  if (reminders.length > 0) {
    const describe = (/** @type {Named} */ reminder) => `${reminder.title} (due ${reminder.due}${reminder.overdue ? ", overdue" : ", today"})`;
    lines.push(`Reminders due (${reminders.length}):`, ...bullets(reminders, NAMED.reminders, describe, "lampstand remind list"));
  }
  return lines;
}

/**
 * One line counting the open items of the kinds the attention lines do not name (captures, ideas, knowledge), and
 * the files that do not parse; nothing when there are none.
 * @param {Counts} counts
 * @param {OrgSchema} schema
 */
function otherLines(counts, schema) {
  const parts = [];
  for (const kind of schema.kinds.values()) {
    const perKind = counts[kind.name];
    if (!perKind) continue;
    if (!["task", "decision", "reminder"].includes(kind.name)) {
      const open = Object.entries(perKind)
        .filter(([status]) => status === NO_STATUS || (status !== UNPARSED && !isTerminal(kind, status)))
        .reduce((sum, [, n]) => sum + n, 0);
      if (open > 0) parts.push(`${open} ${kind.name}`);
    }
    const unparsed = perKind[UNPARSED] ?? 0;
    if (unparsed > 0) parts.push(`${unparsed} ${kind.name} file${unparsed === 1 ? " that does" : "s that do"} not parse`);
  }
  return parts.length === 0 ? [] : [`Also open: ${parts.join(", ")}.`];
}

/**
 * One line per kind that has items, statuses in schema order, then any status outside it.
 * @param {Counts} counts
 * @param {OrgSchema} schema
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
  return lines;
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
