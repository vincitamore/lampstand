// @ts-check
// The seat: every write lampstand made outside the house that needed consent, read from and reversed through the
// one seat ledger (core/lib/seat/ledger.js holds its format and its reader and writer). Each entry is undone by
// the module that owns its kind: OS scheduler entries through the scheduler's own revert, per-user config keys here.
// Reset walks the ledger newest first, so a later write is undone before an earlier one it may have depended on.
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { loadUserConfig, userConfigPath } from "../config.js";
import { atomicWrite, readText } from "../io.js";
import { parseToml } from "../parse/toml.js";
import { revert } from "../scheduler/os.js";
import { dropSeat, readSeat, recordSeat, seatPath } from "./ledger.js";
import { tomlString } from "../parse/toml.js";

/** @typedef {import("./ledger.js").SeatEntry} SeatEntry */
/** @typedef {import("../scheduler/os.js").Host} Host */

/** The ledger kind of a per-user config key; the key's name is the part of the id after `user-config:`. */
export const USER_CONFIG_KIND = "user-config";

/** @param {string} key */
const configId = (key) => `${USER_CONFIG_KIND}:${key}`;

/**
 * Sets or removes a top-level string key in per-user config.toml, changing only that key's line; the file is
 * created when missing and removed when the key was all it held.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 * @param {string | null} value  null removes the key
 */
function writeConfigKey(env, key, value) {
  const path = userConfigPath(env);
  const text = existsSync(path) ? readText(path) : "";
  const lines = new Map();
  parseToml(text, path, { lines });
  const at = lines.get(JSON.stringify([key]));
  const rows = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const line = value === null ? null : `${key} = ${tomlString(value)}`;
  if (at !== undefined) {
    if (line === null) rows.splice(at - 1, 1);
    else rows[at - 1] = line;
  } else if (line !== null) {
    // A top-level key must come before the first table header, so it goes first.
    rows.unshift(line);
  }
  const next = rows.length === 0 ? "" : `${rows.join("\n")}\n`;
  if (next.trim() === "") {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, next);
  loadUserConfig(env);
}

/**
 * Records `root` as default_house in per-user config, through the seat ledger: the entry, carrying the value it
 * replaces, is written before the config is, so `lampstand seat reset` can always restore it.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root  the house, absolute
 * @returns {{ path: string, changed: boolean }}
 */
export function setDefaultHouse(env, root) {
  const path = userConfigPath(env);
  const before = loadUserConfig(env).default_house ?? null;
  if (before === root) return { path, changed: false };
  recordSeat(env, { id: configId("default_house"), owner: "init", house: root, kind: USER_CONFIG_KIND, target: path, before });
  writeConfigKey(env, "default_house", root);
  return { path, changed: true };
}

/** @param {SeatEntry} entry */
function configKeyOf(entry) {
  return entry.id.slice(USER_CONFIG_KIND.length + 1);
}

/** The scheduler's entry key (its OS task name), from an id `scheduler:<key>:<kind>:<target>`. @param {SeatEntry} entry */
function schedulerKeyOf(entry) {
  return entry.id.split(":")[1];
}

/**
 * One line describing what an entry changed.
 * @param {SeatEntry} entry
 */
export function describeEntry(entry) {
  if (entry.kind === USER_CONFIG_KIND) {
    const was = entry.before === null ? "unset" : JSON.stringify(entry.before);
    return `${configKeyOf(entry)} in ${entry.target} (was ${was})`;
  }
  return `${entry.kind} ${entry.target} (${entry.before === null ? "created" : "replaced an earlier one"})`;
}

/**
 * The ledger's entries, newest first.
 * @param {NodeJS.ProcessEnv} env
 */
export function seatEntries(env) {
  return [...readSeat(env).entries].reverse();
}

/**
 * Reverses every entry, newest first, dropping each from the ledger once undone. An entry of a kind this lampstand
 * cannot reverse (written by a newer one) is left in the ledger and reported.
 * @param {Host} host  the OS the scheduler entries live on; host.env locates the ledger and per-user config
 * @returns {{ undone: string[], left: SeatEntry[] }}
 */
export function seatReset(host) {
  const env = host.env;
  /** @type {string[]} */
  const undone = [];
  /** @type {SeatEntry[]} */
  const left = [];
  /** @type {Set<string>} */
  const schedulerKeys = new Set();
  for (const entry of seatEntries(env)) {
    if (entry.owner === "scheduler") {
      const key = schedulerKeyOf(entry);
      if (schedulerKeys.has(key)) continue;
      schedulerKeys.add(key);
      undone.push(...revert(host, key));
    } else if (entry.kind === USER_CONFIG_KIND) {
      const key = configKeyOf(entry);
      writeConfigKey(env, key, entry.before);
      dropSeat(env, entry.id);
      undone.push(entry.before === null ? `removed ${key} from ${entry.target}` : `restored ${key} in ${entry.target} to ${JSON.stringify(entry.before)}`);
    } else {
      left.push(entry);
    }
  }
  // An empty ledger is itself a trace on this machine; so is lampstand's config folder once nothing is left in it.
  const ledger = seatPath(env);
  if (existsSync(ledger) && readSeat(env).entries.length === 0) {
    rmSync(ledger);
    if (readdirSync(dirname(ledger)).length === 0) rmdirSync(dirname(ledger));
  }
  return { undone, left };
}
