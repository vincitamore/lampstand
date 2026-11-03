// @ts-check
// One SQLite surface over bun:sqlite (under Bun) and node:sqlite (under Node), picked at runtime. Only the calls
// lampstand needs are exposed, with positional parameters, so both drivers behave the same: bun:sqlite returns null
// for a missing row where node:sqlite returns undefined, and named parameters differ in prefix rules. bun:sqlite
// closes lazily while any statement is unfinalized, which keeps house.db open (and, on Windows, undeletable) until
// garbage collection, so every statement is finalized no later than close().
import { createRequire } from "node:module";
import { fail } from "../errors.js";
import { errorMessage } from "../io.js";

/** @typedef {null | number | bigint | string | Uint8Array} SqlValue */
/** @typedef {Record<string, SqlValue>} Row */
/**
 * @typedef {{
 *   run(...params: SqlValue[]): unknown,
 *   get(...params: SqlValue[]): Row | null | undefined,
 *   all(...params: SqlValue[]): Row[],
 *   finalize?: () => void,
 * }} RawStatement
 */
/** @typedef {{ exec(sql: string): unknown, prepare(sql: string): RawStatement, close(): unknown }} RawDatabase */

const require = createRequire(import.meta.url);

/** "bun:sqlite" or "node:sqlite": the driver this runtime uses. */
export const DRIVER = process.versions.bun ? "bun:sqlite" : "node:sqlite";

/** @returns {new (path: string) => RawDatabase} */
function driverClass() {
  try {
    if (DRIVER === "bun:sqlite") return require("bun:sqlite").Database;
    // Node marks node:sqlite experimental and prints that on every CLI run that opens house.db. Only that one
    // warning, raised while the module loads, is dropped; every other warning still reaches the default handler.
    const emit = process.emitWarning;
    /** @param {any} warning @param {any[]} rest */
    const filtered = (warning, ...rest) => {
      const text = typeof warning === "string" ? warning : String(warning?.message ?? "");
      const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type ?? (typeof warning === "string" ? "" : warning?.name);
      if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
      /** @type {any} */ (emit).call(process, warning, ...rest);
    };
    process.emitWarning = /** @type {any} */ (filtered);
    try {
      return require("node:sqlite").DatabaseSync;
    } finally {
      process.emitWarning = emit;
    }
  } catch (cause) {
    throw fail("E_SQLITE_UNAVAILABLE", `${DRIVER} cannot be loaded: ${errorMessage(cause)}`, { cause });
  }
}

export class Statement {
  /** @param {RawStatement} raw */
  constructor(raw) {
    this.raw = raw;
  }

  /** @param {SqlValue[]} params */
  run(...params) {
    this.raw.run(...params);
  }

  /** @param {SqlValue[]} params @returns {Row | undefined} */
  get(...params) {
    return this.raw.get(...params) ?? undefined;
  }

  /** @param {SqlValue[]} params @returns {Row[]} */
  all(...params) {
    return this.raw.all(...params);
  }
}

export class Database {
  /** @param {string} path */
  constructor(path) {
    const Driver = driverClass();
    /** @type {RawDatabase} */
    this.raw = new Driver(path);
    this.path = path;
    /** @type {Set<RawStatement>} */
    this.statements = new Set();
  }

  /** Runs one or more statements without parameters. @param {string} sql */
  exec(sql) {
    this.raw.exec(sql);
  }

  /** A statement that lives until close(). @param {string} sql */
  prepare(sql) {
    const raw = this.raw.prepare(sql);
    this.statements.add(raw);
    return new Statement(raw);
  }

  /**
   * Runs `use` on a one-off statement and finalizes it straight away.
   * @template T
   * @param {string} sql
   * @param {(statement: Statement) => T} use
   * @returns {T}
   */
  once(sql, use) {
    const raw = this.raw.prepare(sql);
    try {
      return use(new Statement(raw));
    } finally {
      raw.finalize?.();
    }
  }

  /** @param {string} sql @param {SqlValue[]} params @returns {Row | undefined} */
  get(sql, ...params) {
    return this.once(sql, (statement) => statement.get(...params));
  }

  /** @param {string} sql @param {SqlValue[]} params */
  run(sql, ...params) {
    this.once(sql, (statement) => statement.run(...params));
  }

  /**
   * Runs `fn` in a write transaction taken up front (BEGIN IMMEDIATE), so concurrent writers queue on the busy
   * timeout instead of failing to upgrade a read lock midway.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLite may already have rolled back (e.g. on SQLITE_FULL); the original error is the one worth reporting.
      try {
        this.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  close() {
    for (const raw of this.statements) raw.finalize?.();
    this.statements.clear();
    this.raw.close();
  }
}
