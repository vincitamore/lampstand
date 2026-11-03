// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { gate, repo, tempDir } from "./helpers.js";

const EM_DASH = "\u2014";

test("prose-gate passes plain text, Latin-1 signs, box drawing and anything outside the shipped set", (t) => {
  const root = repo(t, {
    "README.md": "Plain text: a < b, 3 \u00d7 4, \u00a9 the authors.\n",
    "docs/assets/art.txt": "\u250c\u2500\u2510\n\u2514\u2500\u2518 \u2588\u2591\n",
    "test/notes.md": `not shipped ${EM_DASH} \u2192\n`,
    "packs/lattice/LATTICE.md": `### \u221e\u21920 : Inversion ${EM_DASH} exempt by name\n`,
  });
  const run = gate("prose-gate.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 0, run.out);
});

test("prose-gate names path, line and code point of each em dash and symbol mark", (t) => {
  const root = repo(t, {
    "README.md": `one\ntwo ${EM_DASH} three\n`,
    "core/lib/x.js": "// a \u2192 b\nconst ok = 1;\n// \u2713 done \u{1F600}\n",
    "packs/lattice/other.md": "\u2605\n",
  });
  const run = gate("prose-gate.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 1, run.out);
  assert.deepEqual(run.stdout.trim().split("\n"), [
    "README.md:2:U+2014",
    "core/lib/x.js:1:U+2192",
    "core/lib/x.js:3:U+2713",
    "core/lib/x.js:3:U+1F600",
    "packs/lattice/other.md:1:U+2605",
  ]);
});

test("prose-gate refuses an unknown flag with the usage exit code", (t) => {
  const run = gate("prose-gate.js", ["--fix"], tempDir(t));
  assert.equal(run.status, 64, run.out);
});
