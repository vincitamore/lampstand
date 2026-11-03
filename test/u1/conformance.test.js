// @ts-check
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { isLampstandError } from "../../core/lib/errors.js";
import { parseFrontmatter } from "../../core/lib/frontmatter.js";
import { contentHash } from "../../core/lib/io.js";
import { parseToml } from "../../core/lib/parse/toml.js";
import { resolveHouse } from "../../core/lib/root.js";
import { tempDir, vectors } from "./helpers.js";

/**
 * Asserts that `run` throws the vector's expected error, naming `path` and the expected line.
 * @param {() => unknown} run
 * @param {{ code: string, line: number, message: string }} expected
 * @param {string} path
 */
function assertRefused(run, expected, path) {
  assert.throws(run, (error) => {
    assert.ok(isLampstandError(error), `expected a LampstandError, got ${error}`);
    assert.equal(error.code, expected.code);
    assert.equal(error.path, path);
    assert.equal(error.line, expected.line, error.message);
    assert.ok(error.message.startsWith(`${path}:${expected.line}: `), error.message);
    assert.ok(error.message.includes(expected.message), `${JSON.stringify(error.message)} lacks ${JSON.stringify(expected.message)}`);
    return true;
  });
}

test("hash vectors: contentHash matches every digest", () => {
  for (const { file, vector } of vectors("hash")) {
    assert.equal(contentHash(vector.input), vector.sha256, `${file}: ${vector.description}`);
  }
});

test("toml vectors: valid input parses to the expected value; refused input fails with code, path and line", () => {
  for (const { file, vector } of vectors("toml")) {
    const label = `${file}: ${vector.description}`;
    if (vector.error) assertRefused(() => parseToml(vector.input, "vector.toml"), vector.error, "vector.toml");
    else assert.deepStrictEqual(parseToml(vector.input, "vector.toml"), vector.expected, label);
  }
});

test("frontmatter vectors: valid input parses to the expected value; refused input fails with code, path and line", () => {
  for (const { file, vector } of vectors("frontmatter")) {
    const label = `${file}: ${vector.description}`;
    if (vector.error) assertRefused(() => parseFrontmatter(vector.input, "vector.md"), vector.error, "vector.md");
    else assert.deepStrictEqual(parseFrontmatter(vector.input, "vector.md"), vector.expected, label);
  }
});

test("root vectors: resolution follows the four rules in order", (t) => {
  for (const { file, vector } of vectors("root")) {
    const label = `${file}: ${vector.description}`;
    const T = tempDir(t);
    for (let dir = dirname(T); dirname(dir) !== dir; dir = dirname(dir)) {
      assert.ok(!existsSync(join(dir, "house.toml")), `the temp directory sits beneath a house at ${dir}; vectors need a clean ancestry`);
    }
    /** @param {string} rel */
    const at = (rel) => (rel === "" ? T : join(T, ...rel.split("/")));
    /** @param {string} text */
    const fill = (text) => text.replaceAll("{T}", T);
    for (const dir of vector.dirs ?? []) mkdirSync(at(dir), { recursive: true });
    for (const [rel, content] of Object.entries(vector.files ?? {})) {
      mkdirSync(dirname(at(rel)), { recursive: true });
      writeFileSync(at(rel), /** @type {string} */ (content));
    }
    if (vector.config !== undefined) {
      mkdirSync(join(T, "config", "lampstand"), { recursive: true });
      writeFileSync(join(T, "config", "lampstand", "config.toml"), fill(vector.config));
    }
    /** @type {NodeJS.ProcessEnv} */
    const env = { LAMPSTAND_CONFIG_ROOT: join(T, "config") };
    for (const [key, value] of Object.entries(vector.env)) env[key] = fill(/** @type {string} */ (value));
    const options = { cwd: at(vector.cwd), env, workspace: vector.workspace };
    if (vector.expect.error) {
      assert.throws(
        () => resolveHouse(options),
        (error) => isLampstandError(error) && error.code === vector.expect.error,
        label,
      );
    } else {
      const expected = { rule: vector.expect.rule, root: vector.expect.root === null ? null : at(vector.expect.root) };
      assert.deepStrictEqual(resolveHouse(options), expected, label);
    }
  }
});
