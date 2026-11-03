// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { gate, repo, tempDir } from "./helpers.js";

test("link-check passes links, images, definitions and HTML that resolve, and skips what is not relative", (t) => {
  const root = repo(t, {
    "README.md": [
      "[Concepts](docs/concepts.md#what-loads) and [first run](<docs/first run.md> \"title\").",
      "![logo](docs/assets/logo.txt) [the docs folder](docs/) [root](/SECURITY.md)",
      "[site](https://example.invalid/x) [mail](mailto:a@example.invalid) [here](#top) [proto](//example.invalid)",
      '<img src="docs/assets/logo.txt" alt=""> <a href="docs/first%20run.md">x</a>',
      "[ref]: docs/concepts.md",
      "`[in code](missing.md)`",
      "```",
      "[in a fence](missing.md)",
      "```",
      "",
    ].join("\n"),
    "SECURITY.md": "# Security\n",
    "docs/concepts.md": "[back](../README.md)\n",
    "docs/first run.md": "x\n",
    "docs/assets/logo.txt": "x\n",
  });
  const run = gate("link-check.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 0, run.out);
});

test("link-check names each link that does not resolve to a file in the repository", (t) => {
  const root = repo(t, {
    ".gitignore": "ignored.md\n",
    "ignored.md": "x\n",
    "README.md": "fine [a](SECURITY.md)\n[gone](docs/gone.md)\n![img](docs/missing.png)\n",
    "SECURITY.md": "[up](../outside.md) [ignored](ignored.md)\n",
    "docs/x.md": "[ref]: nowhere.md\n<img src='nope.txt'>\n",
  });
  const run = gate("link-check.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 1, run.out);
  assert.deepEqual(run.stdout.trim().split("\n"), [
    "README.md:2: docs/gone.md does not resolve to a file in the repository",
    "README.md:3: docs/missing.png does not resolve to a file in the repository",
    "SECURITY.md:1: ../outside.md does not resolve to a file in the repository",
    "SECURITY.md:1: ignored.md does not resolve to a file in the repository",
    "docs/x.md:1: nowhere.md does not resolve to a file in the repository",
    "docs/x.md:2: nope.txt does not resolve to a file in the repository",
  ]);
});
