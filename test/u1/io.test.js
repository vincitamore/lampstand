// @ts-check
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isLampstandError } from "../../core/lib/errors.js";
import { atomicWrite, readText } from "../../core/lib/io.js";
import { tempDir } from "./helpers.js";

test("atomicWrite replaces a file with LF text and leaves no temp file behind", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "note.md");
  writeFileSync(path, "old\r\n");
  atomicWrite(path, "a\r\nb\r\n");
  assert.equal(readFileSync(path, "utf8"), "a\nb\n");
  assert.deepEqual(readdirSync(dir), ["note.md"]);
});

test("atomicWrite with lf: false keeps the bytes as given", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "raw.txt");
  atomicWrite(path, "a\r\nb", { lf: false });
  assert.equal(readFileSync(path, "utf8"), "a\r\nb");
});

test("atomicWrite into a missing directory fails with E_IO and cleans up", (t) => {
  const dir = tempDir(t);
  assert.throws(
    () => atomicWrite(join(dir, "missing", "x.txt"), "x"),
    (error) => isLampstandError(error) && error.code === "E_IO" && error.path === join(dir, "missing", "x.txt"),
  );
  assert.deepEqual(readdirSync(dir), []);
});

test("readText drops a BOM and normalizes CRLF", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "bom.md");
  writeFileSync(path, "\ufeffx\r\ny\r\n");
  assert.equal(readText(path), "x\ny\n");
});
