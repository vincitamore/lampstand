// @ts-check
// The seat ledger, seat.json beside per-user config.toml, lists every write lampstand made outside the house and
// its own state with the value it replaced, so each can be reversed. An entry is recorded before its write is
// made, so a write interrupted halfway is still on record; recording the same id again keeps the first before-value,
// because that, not lampstand's own intermediate state, is what a reversal must restore.
//
//   { "schema": 1, "entries": [ { "id", "owner", "house", "kind", "target", "before", "at", ...detail } ] }
//
// `before` is the prior content (a file, a crontab, a task definition) or a prior state word, and null when the
// target did not exist.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configRoot } from "../config.js";
import { fail } from "../errors.js";
import { atomicWrite, readText } from "../io.js";

/**
 * @typedef {{
 *   id: string,
 *   owner: string,
 *   house: string,
 *   kind: string,
 *   target: string,
 *   before: string | null,
 *   at: string,
 *   line?: string,
 * }} SeatEntry
 */
/** @typedef {{ schema: 1, entries: SeatEntry[] }} Seat */

/** @param {NodeJS.ProcessEnv} env */
export function seatPath(env) {
  return join(configRoot(env), "lampstand", "seat.json");
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Seat}
 */
export function readSeat(env) {
  const path = seatPath(env);
  if (!existsSync(path)) return { schema: 1, entries: [] };
  let data;
  try {
    data = JSON.parse(readText(path));
  } catch (cause) {
    throw fail("E_SCHEMA", `the seat ledger is not valid JSON: ${/** @type {Error} */ (cause).message}`, { path, cause });
  }
  if (data?.schema !== 1 || !Array.isArray(data.entries)) {
    throw fail("E_SCHEMA", "the seat ledger must be an object with schema 1 and an entries array", { path });
  }
  return /** @type {Seat} */ (data);
}

/** @param {NodeJS.ProcessEnv} env @param {Seat} seat */
function writeSeat(env, seat) {
  const path = seatPath(env);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify(seat, null, 2)}\n`);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Omit<SeatEntry, "at">} entry
 */
export function recordSeat(env, entry) {
  const seat = readSeat(env);
  if (!seat.entries.some((existing) => existing.id === entry.id)) {
    seat.entries.push({ ...entry, at: new Date().toISOString() });
    writeSeat(env, seat);
  }
}

/** @param {NodeJS.ProcessEnv} env @param {string} id */
export function dropSeat(env, id) {
  const seat = readSeat(env);
  writeSeat(env, { ...seat, entries: seat.entries.filter((entry) => entry.id !== id) });
}
