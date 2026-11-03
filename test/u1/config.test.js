// @ts-check
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { HOUSE_SCHEMA_VERSION, loadHouseConfig, loadUserConfig, parseHouseToml } from "../../core/lib/config.js";
import { isLampstandError } from "../../core/lib/errors.js";
import { HOUSE_ID, HOUSE_TOML, isolatedEnv, plant, tempDir } from "./helpers.js";

/**
 * @param {() => unknown} run
 * @param {string} code
 * @param {number | undefined} line
 * @param {string} fragment
 */
function assertFails(run, code, line, fragment) {
  assert.throws(run, (error) => {
    assert.ok(isLampstandError(error));
    assert.equal(error.code, code, error.message);
    assert.equal(error.line, line, error.message);
    assert.ok(error.message.includes(fragment), error.message);
    return true;
  });
}

test("a complete house.toml validates and loads from disk", (t) => {
  const root = tempDir(t);
  plant(root, {
    "house.toml": `${HOUSE_TOML}[operator]\nname = "ana"\nco_owners = ["ben"]\n[charter]\nmode = "agreement"\n[modules]\nscheduler = true\n[gate]\nmode = "block"\n[plugin]\nmin = "0.1.0"\n`,
  });
  const config = loadHouseConfig(root);
  assert.equal(config.house.id, HOUSE_ID);
  assert.deepEqual(config.operator, { name: "ana", co_owners: ["ben"] });
  assert.equal(config.charter?.mode, "agreement");
  assert.equal(config.gate?.mode, "block");
});

test("schema violations name the key and the line it is on", () => {
  assertFails(() => parseHouseToml("[house]\nschema = 1\nname = \"x\"\n", "h.toml"), "E_SCHEMA", 1, "house is missing required key id");
  assertFails(() => parseHouseToml(`${HOUSE_TOML}[charter]\nmode = "anarchy"\n`, "h.toml"), "E_SCHEMA", 6, "charter.mode must be one of");
  assertFails(() => parseHouseToml(`${HOUSE_TOML}[modules]\nrooms = "yes"\n`, "h.toml"), "E_SCHEMA", 6, "modules.rooms must be of type boolean");
  assertFails(() => parseHouseToml(`${HOUSE_TOML}[operator]\nco_owners = ["a", 2]\n`, "h.toml"), "E_SCHEMA", 6, "operator.co_owners[1] must be of type string");
  assertFails(() => parseHouseToml(`${HOUSE_TOML}[purpose]\ntext = "${"x".repeat(601)}"\n`, "h.toml"), "E_SCHEMA", 6, "at most 600 characters");
  assertFails(() => parseHouseToml(HOUSE_TOML.replace(HOUSE_ID, "not-a-uuid"), "h.toml"), "E_SCHEMA", 3, "house.id must match");
  assertFails(() => parseHouseToml(HOUSE_TOML.replace("schema = 1", "schema = 0"), "h.toml"), "E_SCHEMA", 2, "house.schema must be at least 1");
});

test("unknown top-level tables are refused; the document without [house] is refused", () => {
  assertFails(() => parseHouseToml(`${HOUSE_TOML}\n[surprise]\nx = 1\n`, "h.toml"), "E_SCHEMA", 6, "surprise is not a known key");
  assertFails(() => parseHouseToml("", "h.toml"), "E_SCHEMA", undefined, "the document is missing required key house");
});

test("a newer house.schema is E_SCHEMA_NEWER even when the rest would not validate", () => {
  const newer = HOUSE_SCHEMA_VERSION + 1;
  assertFails(
    () => parseHouseToml(`[house]\nschema = ${newer}\n[future_table]\nx = 1\n`, "h.toml"),
    "E_SCHEMA_NEWER",
    2,
    `house.schema = ${newer} is newer than this lampstand understands (${HOUSE_SCHEMA_VERSION})`,
  );
});

test("TOML outside the subset in house.toml is E_PARSE_TOML naming house.toml", (t) => {
  const root = tempDir(t);
  plant(root, { "house.toml": `${HOUSE_TOML}[[packs]]\n` });
  assert.throws(
    () => loadHouseConfig(root),
    (error) => isLampstandError(error) && error.code === "E_PARSE_TOML" && error.path === join(root, "house.toml") && error.line === 5,
  );
});

test("per-user config: absent is empty, unknown keys are refused, per-house entries validate", (t) => {
  const dir = tempDir(t);
  const env = isolatedEnv(dir);
  assert.deepEqual(loadUserConfig(env), {});
  const path = join(dir, "config-root", "lampstand", "config.toml");
  plant(dir, { "config-root/lampstand/config.toml": `default_house = '/x'\n[houses."${HOUSE_ID}"]\nstate_dir = '/s'\n` });
  assert.deepEqual(loadUserConfig(env), { default_house: "/x", houses: { [HOUSE_ID]: { state_dir: "/s" } } });
  plant(dir, { "config-root/lampstand/config.toml": `[houses."${HOUSE_ID}"]\nstate_dirs = '/s'\n` });
  assert.throws(
    () => loadUserConfig(env),
    (error) => isLampstandError(error) && error.code === "E_SCHEMA" && error.path === path && error.line === 2,
  );
  plant(dir, { "config-root/lampstand/config.toml": "theme = 'dark'\n" });
  assert.throws(() => loadUserConfig(env), (error) => isLampstandError(error) && error.code === "E_SCHEMA");
});

test("a relative LAMPSTAND_CONFIG_ROOT is refused", () => {
  assert.throws(
    () => loadUserConfig({ LAMPSTAND_CONFIG_ROOT: "relative/dir" }),
    (error) => isLampstandError(error) && error.code === "E_ENV_INVALID",
  );
});
