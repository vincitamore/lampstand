// @ts-check
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findWikilinks, maskCode } from "../../core/lib/org/markdown.js";
import { cliJson, makeHouse, read } from "./helpers.js";

test("relink moves a file and rewrites path and name links across the house, outside code only", async (t) => {
  const house = makeHouse(t, {
    files: {
      "knowledge/old-name.md": "# Old\n",
      "principles/notes.md": [
        "[[knowledge/old-name]] [[old-name|alias]] [[Knowledge/Old-Name.md#Part]] [[other]]",
        "```",
        "[[knowledge/old-name]]",
        "```",
        "`[[old-name]]` stays",
        "",
      ].join("\n"),
      "knowledge/other.md": "# Other\n",
      ".house/generated/router.omp.md": "[[knowledge/old-name]]\n",
    },
  });
  const { code, body } = await cliJson(["relink", "knowledge/old-name.md", "knowledge/archive/new-name.md"], house);
  assert.equal(code, 0, JSON.stringify(body));
  assert.equal(body.moved, true);
  assert.ok(existsSync(join(house.root, "knowledge", "archive", "new-name.md")));
  assert.equal(
    read(house.root, "principles/notes.md"),
    [
      "[[knowledge/archive/new-name]] [[new-name|alias]] [[knowledge/archive/new-name.md#Part]] [[other]]",
      "```",
      "[[knowledge/old-name]]",
      "```",
      "`[[old-name]]` stays",
      "",
    ].join("\n"),
  );
  // Generated projections are rebuilt by the compiler, never edited by relink.
  assert.equal(read(house.root, ".house/generated/router.omp.md"), "[[knowledge/old-name]]\n");
  assert.deepEqual(body.relinked, [{ path: "principles/notes.md", links: 3 }]);
});

test("relink after a move made by hand rewrites only; with both or neither path present it refuses", async (t) => {
  const house = makeHouse(t, { files: { "a/new.md": "x\n", "b.md": "[[a/old]]\n" } });
  const done = await cliJson(["relink", "a/old.md", "a/new.md"], house);
  assert.equal(done.code, 0);
  assert.equal(done.body.moved, false);
  assert.equal(read(house.root, "b.md"), "[[a/new]]\n");
  assert.equal((await cliJson(["relink", "a/new.md", "b.md"], house)).code, 64);
  assert.equal((await cliJson(["relink", "x.md", "y.md"], house)).code, 64);
  assert.equal((await cliJson(["relink", "a/new.md", "../escape.md"], house)).code, 64);
});

test("a name link that another file still answers to is left alone", async (t) => {
  const house = makeHouse(t, { files: { "one/dup.md": "1\n", "two/dup.md": "2\n", "n.md": "[[dup]]\n" } });
  assert.equal((await cliJson(["relink", "one/dup.md", "one/moved.md"], house)).code, 0);
  assert.equal(read(house.root, "n.md"), "[[dup]]\n");
});

test("wikilinks report target, rest and line; code is masked without shifting offsets", () => {
  const text = "a\n[[x#h|y]] `[[no]]`\n```\n[[no]]\n```\n![[img.png]]\n";
  assert.equal(maskCode(text).length, text.length);
  assert.deepEqual(
    findWikilinks(text).map((link) => [link.target, link.rest, link.line]),
    [["x", "#h|y", 2], ["img.png", "", 6]],
  );
});

test("relink of a non-Markdown file rewrites its name and path links", async (t) => {
  const house = makeHouse(t, { files: { "assets/a.png": "p", "n.md": "![[a.png]] [[assets/a.png]]\n" } });
  assert.equal((await cliJson(["relink", "assets/a.png", "assets/b.png"], house)).code, 0);
  assert.equal(read(house.root, "n.md"), "![[b.png]] [[assets/b.png]]\n");
});
