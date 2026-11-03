// @ts-check
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fail } from "./errors.js";

/**
 * CRLF becomes LF; a lone CR is kept. This matches git's `eol=lf` conversion, so a working-tree file checked out
 * with CRLF hashes the same as the committed blob.
 * @param {string} text
 */
export function normalizeLf(text) {
  return text.includes("\r\n") ? text.replaceAll("\r\n", "\n") : text;
}

/** @param {string} text */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * sha256 hex over the UTF-8 bytes of `text` after dropping a leading BOM and normalizing CRLF to LF. The Python
 * reader computes the same digest to verify generated projections, so the definition is pinned by vectors.
 * @param {string} text
 */
export function contentHash(text) {
  return createHash("sha256").update(normalizeLf(stripBom(text)), "utf8").digest("hex");
}

/**
 * Reads a UTF-8 text file without its BOM and with LF line endings.
 * @param {string} path
 */
export function readText(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw fail("E_IO", `cannot read: ${errorMessage(cause)}`, { path, cause });
  }
  return normalizeLf(stripBom(raw));
}

/**
 * Writes `text` so a reader sees either the old file or the new one, never a torn one: the bytes go to a temp file
 * in the same directory (a rename is atomic only within one filesystem), are flushed, and replace the target by
 * rename. Text is LF-normalized unless `lf` is false.
 * @param {string} path
 * @param {string} text
 * @param {{ lf?: boolean }} [options]
 */
export function atomicWrite(path, text, options = {}) {
  const body = options.lf === false ? text : normalizeLf(text);
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(temp, "wx");
    try {
      const bytes = Buffer.from(body, "utf8");
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (cause) {
    rmSync(temp, { force: true });
    throw fail("E_IO", `cannot write: ${errorMessage(cause)}`, { path, cause });
  }
  // The rename is durable only once the directory entry is flushed. Windows cannot open a directory for fsync.
  if (process.platform !== "win32") {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}

/** @param {unknown} error */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
