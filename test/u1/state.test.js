// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isLampstandError } from "../../core/lib/errors.js";
import { STATE_SCHEMA_VERSION, openHouseState, openStateDb, parseMigrations } from "../../core/lib/state/db.js";
import { stateDirFor, stateRoot } from "../../core/lib/state/paths.js";
import { HOUSE_ID, HOUSE_TOML, isolatedEnv, plant, tempDir } from "./helpers.js";

test("the default state directory is <state root>/lampstand/<id>-<sha8(realpath root)>", (t) => {
  const dir = tempDir(t);
  const env = isolatedEnv(dir);
  const root = join(dir, "house");
  plant(root, { "house.toml": HOUSE_TOML });
  const sha8 = createHash("sha256").update(root, "utf8").digest("hex").slice(0, 8);
  assert.equal(stateRoot(env), join(dir, "state-root"));
  assert.deepEqual(stateDirFor(root, HOUSE_ID, env), {
    dir: join(dir, "state-root", "lampstand", `${HOUSE_ID}-${sha8}`),
    source: "default",
  });
});

test("two clones of one house get different state directories", (t) => {
  const dir = tempDir(t);
  const env = isolatedEnv(dir);
  plant(dir, { "a/house.toml": HOUSE_TOML, "b/house.toml": HOUSE_TOML });
  assert.notEqual(stateDirFor(join(dir, "a"), HOUSE_ID, env).dir, stateDirFor(join(dir, "b"), HOUSE_ID, env).dir);
});

test("per-user config overrides the state directory for one house only", (t) => {
  const dir = tempDir(t);
  const env = isolatedEnv(dir);
  const custom = join(dir, "custom-state");
  plant(dir, {
    "house/house.toml": HOUSE_TOML,
    "config-root/lampstand/config.toml": `[houses."${HOUSE_ID}"]\nstate_dir = '${custom}'\n`,
  });
  assert.deepEqual(stateDirFor(join(dir, "house"), HOUSE_ID, env), { dir: custom, source: "config" });
  const other = "11111111-2222-4333-8444-555555555555";
  assert.equal(stateDirFor(join(dir, "house"), other, env).source, "default");
});

test("a relative state_dir override and a relative LAMPSTAND_STATE_ROOT are refused", (t) => {
  const dir = tempDir(t);
  const env = isolatedEnv(dir);
  plant(dir, { "house/house.toml": HOUSE_TOML, "config-root/lampstand/config.toml": `[houses."${HOUSE_ID}"]\nstate_dir = 'rel'\n` });
  assert.throws(() => stateDirFor(join(dir, "house"), HOUSE_ID, env), (e) => isLampstandError(e) && e.code === "E_SCHEMA");
  assert.throws(() => stateRoot({ LAMPSTAND_STATE_ROOT: "rel" }), (e) => isLampstandError(e) && e.code === "E_ENV_INVALID");
});

test("openHouseState creates the directory on first use, in WAL mode, at the current schema version", (t) => {
  const dir = tempDir(t);
  const env = isolatedEnv(dir);
  const root = join(dir, "house");
  plant(root, { "house.toml": HOUSE_TOML });
  const expectedDir = stateDirFor(root, HOUSE_ID, env).dir;
  assert.equal(existsSync(expectedDir), false);
  const state = openHouseState(root, env);
  try {
    assert.equal(state.dir, expectedDir);
    assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
    assert.equal(String(state.db.get("PRAGMA journal_mode")?.journal_mode).toLowerCase(), "wal");
    assert.equal(state.db.get("SELECT value FROM meta WHERE key = 'schema_version'")?.value, String(STATE_SCHEMA_VERSION));
    const tables = state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    // Later migrations add tables; the foundation's own must be there.
    for (const name of ["events", "job_runs", "meta"]) assert.ok(tables.includes(name), `missing table ${name}: ${tables}`);
    // Nothing is written into the house itself.
    assert.deepEqual(readdirSync(root), ["house.toml"]);
  } finally {
    state.db.close();
  }
});

test("reopening keeps data and does not re-run migrations", (t) => {
  const dir = join(tempDir(t), "state");
  const first = openStateDb(dir);
  first.db.run("INSERT INTO events (at, kind, payload) VALUES (?, ?, ?)", "2026-01-01T00:00:00Z", "probe", '{"n":1}');
  first.db.close();
  const second = openStateDb(dir);
  try {
    assert.equal(second.db.get("SELECT count(*) AS n FROM events")?.n, 1);
  } finally {
    second.db.close();
  }
});

test("events refuse a payload that is not JSON", (t) => {
  const state = openStateDb(join(tempDir(t), "state"));
  try {
    assert.throws(() => state.db.run("INSERT INTO events (at, kind, payload) VALUES (?, ?, ?)", "t", "k", "not json"));
  } finally {
    state.db.close();
  }
});

test("a house.db migrated by a newer lampstand is refused with E_STATE_SCHEMA_NEWER", (t) => {
  const dir = join(tempDir(t), "state");
  const state = openStateDb(dir);
  state.db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(STATE_SCHEMA_VERSION + 1));
  state.db.close();
  assert.throws(() => openStateDb(dir), (error) => isLampstandError(error) && error.code === "E_STATE_SCHEMA_NEWER");
});

test("a state directory path that is a file is E_STATE_DIR", (t) => {
  const dir = tempDir(t);
  plant(dir, { blocker: "x" });
  assert.throws(() => openStateDb(join(dir, "blocker")), (error) => isLampstandError(error) && error.code === "E_STATE_DIR");
});

test("migrations must be numbered from 1 without gaps", () => {
  assert.deepEqual(
    parseMigrations("-- intro\n-- migration 1\nA;\n-- migration 2\nB;\n").map((m) => [m.version, m.sql.trim()]),
    [
      [1, "A;"],
      [2, "B;"],
    ],
  );
  assert.throws(() => parseMigrations("-- migration 1\nA;\n-- migration 3\nB;\n"), /out of sequence/);
});
