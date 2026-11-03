import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Top-level `key: value` pairs; indented lines belong to the previous key and are not read.
function pluginTopLevel() {
  const keys = new Map();
  for (const line of readFileSync(join(root, "plugin.yaml"), "utf8").split("\n")) {
    if (line.trim() === "" || line.startsWith("#") || /^[ \t]/.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    assert.ok(match, `plugin.yaml: unreadable top-level line ${JSON.stringify(line)}`);
    assert.ok(!keys.has(match[1]), `plugin.yaml: duplicate key ${match[1]}`);
    keys.set(match[1], (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2"));
  }
  return keys;
}

test("package.json installs nothing: no runtime dependency key of any kind", () => {
  for (const key of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    assert.equal(Object.hasOwn(pkg, key), false, `package.json must not declare ${key}`);
  }
});

test("package.json and plugin.yaml name the same version", () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pluginTopLevel().get("version"), pkg.version);
});

test("plugin.yaml asks Hermes for no consent, environment or Python packages", () => {
  const keys = pluginTopLevel();
  for (const key of ["capabilities", "requires_env", "python_dependencies", "pip_dependencies"]) {
    assert.equal(keys.has(key), false, `plugin.yaml must not declare ${key}`);
  }
  assert.equal(keys.get("manifest_version"), "2");
  assert.equal(keys.get("kind"), "standalone");
  assert.equal(keys.get("name"), pkg.name);
});

test("every OMP extension entry in package.json exists", () => {
  assert.ok(Array.isArray(pkg.omp?.extensions) && pkg.omp.extensions.length > 0);
  for (const entry of pkg.omp.extensions) {
    assert.ok(existsSync(join(root, entry)), `missing OMP extension ${entry}`);
  }
});
