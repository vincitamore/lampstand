// @ts-check
// Opens a house's per-machine house.db: creates the state directory on first use, switches to WAL so readers never
// block the writer, and applies the forward-only migrations in schema/runtime.sql.txt (SQL, named .txt so the Hermes install scanner reads it).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHouseConfig } from "../config.js";
import { fail, isLampstandError } from "../errors.js";
import { errorMessage, normalizeLf } from "../io.js";
import { stateDirFor } from "./paths.js";
import { Database } from "./sqlite.js";

/** @typedef {{ version: number, sql: string }} Migration */

/** How long a connection waits for another writer's lock before failing with SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 15000;

/**
 * Splits runtime.sql.txt into its numbered steps. Text before the first `-- migration 1` line is commentary.
 * @param {string} text
 * @returns {Migration[]}
 */
export function parseMigrations(text) {
  /** @type {Migration[]} */
  const steps = [];
  /** @type {string[] | null} */
  let current = null;
  for (const line of normalizeLf(text).split("\n")) {
    const header = /^-- migration (\d+)\s*$/.exec(line);
    if (header) {
      const version = Number(header[1]);
      if (version !== steps.length + 1) throw new Error(`runtime.sql.txt: migration ${version} is out of sequence`);
      current = [];
      steps.push({ version, sql: "" });
    } else if (current) {
      current.push(line);
      steps[steps.length - 1].sql = current.join("\n");
    }
  }
  return steps;
}

export const MIGRATIONS = parseMigrations(readFileSync(new URL("../../../schema/runtime.sql.txt", import.meta.url), "utf8"));

/** The schema version this code migrates house.db to. */
export const STATE_SCHEMA_VERSION = MIGRATIONS.length;

/** @param {Database} db */
function readVersion(db) {
  if (!db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'")) return 0;
  const row = db.get("SELECT value FROM meta WHERE key = 'schema_version'");
  return row ? Number(row.value) : 0;
}

/**
 * Brings house.db to STATE_SCHEMA_VERSION. Concurrent openers serialize on BEGIN IMMEDIATE and re-read the version
 * inside the lock, so each step runs exactly once.
 * @param {Database} db
 * @returns {number} the version after migrating
 */
export function migrate(db) {
  /** @param {number} version */
  const refuseNewer = (version) =>
    fail(
      "E_STATE_SCHEMA_NEWER",
      `house.db is at schema version ${version}, newer than this lampstand understands (${STATE_SCHEMA_VERSION})`,
      { path: db.path },
    );
  const seen = readVersion(db);
  if (seen > STATE_SCHEMA_VERSION) throw refuseNewer(seen);
  if (seen === STATE_SCHEMA_VERSION) return seen;
  return db.transaction(() => {
    const version = readVersion(db);
    if (version > STATE_SCHEMA_VERSION) throw refuseNewer(version);
    for (const step of MIGRATIONS) {
      if (step.version <= version) continue;
      db.exec(step.sql);
      db.run(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        String(step.version),
      );
    }
    return STATE_SCHEMA_VERSION;
  });
}

/**
 * Opens `<dir>/house.db`, creating `dir` if needed, in WAL mode and migrated. Two processes opening a new file at once
 * can meet while it is still in rollback mode, where SQLite refuses one of them at once rather than waiting out the
 * busy timeout (waiting could not help it). The open is repeatable (the journal switch is idempotent and the migration
 * re-reads the version inside its transaction), so a refused attempt is retried until the busy timeout has passed.
 * @param {string} dir
 * @returns {{ db: Database, dir: string, path: string, schemaVersion: number }}
 */
export function openStateDb(dir) {
  ensureDir(dir);
  const path = join(dir, "house.db");
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    /** @type {Database | undefined} */
    let db;
    try {
      db = new Database(path);
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const mode = db.get("PRAGMA journal_mode = WAL");
      if (String(mode?.journal_mode).toLowerCase() !== "wal") {
        throw new Error(`journal_mode is ${String(mode?.journal_mode)}, not wal`);
      }
      // NORMAL is safe against corruption in WAL mode; a power cut can lose only the last commits of machine state.
      db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON");
      const schemaVersion = migrate(db);
      return { db, dir, path, schemaVersion };
    } catch (cause) {
      db?.close();
      if (isLampstandError(cause)) throw cause;
      if (/database is locked|SQLITE_BUSY/i.test(errorMessage(cause)) && Date.now() < deadline) {
        Atomics.wait(pause, 0, 0, Math.min(10 * 2 ** attempt, 200));
        continue;
      }
      throw fail("E_STATE_DB", `cannot open house.db: ${errorMessage(cause)}`, { path, cause });
    }
  }
}

/**
 * Opens the state database of the house at `root`, honouring the per-house state_dir override.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 */
export function openHouseState(root, env = process.env) {
  const { house } = loadHouseConfig(root);
  return openStateDb(stateDirFor(root, house.id, env).dir);
}

/** @param {string} dir */
function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw fail("E_STATE_DIR", `cannot create the state directory: ${errorMessage(cause)}`, { path: dir, cause });
  }
}
