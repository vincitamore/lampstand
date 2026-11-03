// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { gate, plant, repo, tempDir } from "./helpers.js";

const SHIPPED = {
  "package.json": '{ "name": "x" }\n',
  "plugin.yaml": "name: x\n",
  "__init__.py": "from .hosts.hermes.plugin import register\n",
  LICENSE: "MIT\n",
  "README.md": "# x\r\n",
  "SECURITY.md": "# s\n",
  "CHANGELOG.md": "## 0.0.0\n",
  "CONTRIBUTING.md": "# c\n",
  "core/bin/lampstand.js": "#!/usr/bin/env node\n",
  "core/lib/a.js": "export const a = 1;\n",
  "hosts/omp/index.ts": "export default function x(): void {}\n",
  "hosts/hermes/plugin.py": "def register(ctx):\n    pass\n",
  "schema/org.json": "{}\n",
  "templates/root/AGENTS.md": "# AGENTS.md\n",
  "templates/x.toml": "a = 1\n",
  "templates/y.yaml": "a: 1\n",
  "packs/LICENSE": "CC0\n",
  "packs/lattice/LATTICE.md": "## Lattice\n",
  "docs/assets/art.txt": "x\n",
  "skills/house/SKILL.md": "---\nname: house\n---\n",
  "agents/builder.md": "---\nname: builder\n---\n",
};

const UNSHIPPED = {
  ".gitignore": "hosts/__pycache__/\n",
  "hosts/__pycache__/plugin.cpython-312.pyc": "\0bytecode",
  "tsconfig.json": "{}\n",
  "dev/DESIGN.md": "# d\n",
  "test/u0/a.test.js": "x\n",
  ".github/workflows/ci.yml": "name: ci\n",
};

/** Every file under `dir`, as sorted `/`-separated relative paths. @param {string} dir */
function listTree(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

test("release builds exactly the allowlisted files, byte for byte, with a manifest of paths and hashes", (t) => {
  const root = repo(t, { ...SHIPPED, ...UNSHIPPED });
  const scratch = tempDir(t);
  const out = join(scratch, "tree");
  const run = gate("release.js", ["--root", root, "--out", out], scratch);
  assert.equal(run.status, 0, run.out);
  assert.deepEqual(listTree(out), Object.keys(SHIPPED).sort());
  for (const path of Object.keys(SHIPPED)) {
    assert.deepEqual(readFileSync(join(out, path)), readFileSync(join(root, path)), `${path} differs from its source`);
  }
  const manifest = JSON.parse(readFileSync(`${out}.manifest.json`, "utf8"));
  assert.equal(manifest.files, Object.keys(SHIPPED).length);
  for (const entry of manifest.entries) {
    const bytes = readFileSync(join(root, entry.path));
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"), entry.path);
    assert.equal(entry.bytes, bytes.length, entry.path);
  }
});

test("release is reproducible: the same input tree gives byte-identical output and manifest", (t) => {
  const root = repo(t, SHIPPED);
  const scratch = tempDir(t);
  const first = join(scratch, "one", "tree");
  const second = join(scratch, "two", "tree");
  assert.equal(gate("release.js", ["--root", root, "--out", first], scratch).status, 0);
  assert.equal(gate("release.js", ["--root", root, "--out", second], scratch).status, 0);
  assert.deepEqual(listTree(first), listTree(second));
  for (const path of listTree(first)) assert.deepEqual(readFileSync(join(first, path)), readFileSync(join(second, path)), path);
  assert.deepEqual(readFileSync(`${first}.manifest.json`), readFileSync(`${second}.manifest.json`));
});

test("release refuses a file whose extension does not ship, and writes nothing", (t) => {
  const root = repo(t, { ...SHIPPED, "schema/runtime.sql": "-- x\n", "templates/root/gitignore": "x\n", "core/lib/b.mjs": "x\n" });
  const scratch = tempDir(t);
  const out = join(scratch, "tree");
  const run = gate("release.js", ["--root", root, "--out", out], scratch);
  assert.equal(run.status, 1, run.out);
  assert.deepEqual(run.stdout.trim().split("\n").map((line) => line.split(": ")[1]), ["core/lib/b.mjs", "schema/runtime.sql", "templates/root/gitignore"]);
  assert.ok(!existsSync(out), "a refused build wrote the tree");
  assert.ok(!existsSync(`${out}.manifest.json`), "a refused build wrote the manifest");
});

test("release never ships dev/ or test/, whatever the allowlist says", (t) => {
  const root = repo(t, { ...SHIPPED, "dev/x.js": "x\n", "test/y.js": "y\n" });
  plant(root, { "dev/release-allowlist.json": JSON.stringify({ include: ["core/**", "dev/**", "test/**"] }) });
  const scratch = tempDir(t);
  const run = gate("release.js", ["--root", root, "--out", join(scratch, "tree")], scratch);
  assert.equal(run.status, 1, run.out);
  assert.match(run.stdout, /^release: dev\/x\.js: dev\/, test\/, \.github\/ and \.campaign\/ never ship$/m);
  assert.match(run.stdout, /^release: test\/y\.js: /m);
});

test("release refuses an output directory that is not empty", (t) => {
  const root = repo(t, SHIPPED);
  const scratch = tempDir(t);
  plant(scratch, { "tree/stale.md": "x\n" });
  const run = gate("release.js", ["--root", root, "--out", join(scratch, "tree")], scratch);
  assert.equal(run.status, 64, run.out);
  assert.match(run.stderr, /is not an empty directory/);
});
