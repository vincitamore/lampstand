// @ts-check
// One planted fault per core check: each test breaks a healthy planted house in one way and expects the finding's
// code and the exit class doctor reports for it.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runChecks } from "../../core/lib/doctor/checks.js";
import { runCompile } from "../../core/lib/constitution/run.js";
import { openStateDb } from "../../core/lib/state/db.js";
import { stateDirFor } from "../../core/lib/state/paths.js";
import { recordSeat } from "../../core/lib/seat/ledger.js";
import { tickKey } from "../../core/lib/scheduler/os.js";
import { loadHouseConfig } from "../../core/lib/config.js";
import { codes, doctor, doctorEnv, edit, exe, exitOf, plant, plantHouse, schedulerHost, SLOW, tempDir } from "./helpers.js";

/** @param {string} root @param {NodeJS.ProcessEnv} env */
function stateDir(root, env) {
  return stateDirFor(root, loadHouseConfig(root).house.id, env).dir;
}

/** @param {string} root @param {NodeJS.ProcessEnv} env @param {string} sql @param {import("../../core/lib/state/sqlite.js").SqlValue[]} params */
function stateRun(root, env, sql, ...params) {
  const state = openStateDb(stateDir(root, env));
  try {
    state.db.run(sql, ...params);
  } finally {
    state.db.close();
  }
}

/**
 * Turns the scheduler module on and declares one scheduled job, the starter `check` job, then recompiles: house.toml
 * is a compiler input, so the projections would otherwise be stale.
 * @param {string} root
 */
function schedulerOn(root) {
  edit(root, "house.toml", "scheduler = false", "scheduler = true");
  appendFileSync(join(root, "house.toml"), '\n[jobs.check]\nargv = ["lampstand", "check"]\nevery = "1d"\nstale_hours = 48\noutputs = []\nmutates = []\ncommit = false\n');
  runCompile(root);
}

/** @param {string} path */
function readText(path) {
  return readFileSync(path, "utf8");
}

test("a planted house is healthy", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  const report = doctor(env, root);
  assert.deepEqual(report.findings, []);
  assert.equal(report.exit, 0);
});

test("house-marker: no house, a HOUSE_ROOT without one, an unfinished init, and HOUSE_ROOT naming another house", SLOW, (t) => {
  const dir = tempDir(t);
  const env = doctorEnv(dir);
  const outside = doctor(env, dir);
  assert.deepEqual(codes(outside), ["NO_HOUSE"]);
  assert.equal(outside.exit, 3);

  const invalid = doctor({ ...env, HOUSE_ROOT: dir }, dir);
  assert.deepEqual(codes(invalid), ["HOUSE_UNRESOLVED"]);
  assert.equal(invalid.exit, 3);

  const a = plantHouse(t);
  const b = plantHouse(t);
  const elsewhere = doctor({ ...a.env, HOUSE_ROOT: b.root }, a.root);
  assert.deepEqual(codes(elsewhere), ["HOUSE_ROOT_ELSEWHERE"]);
  assert.equal(elsewhere.findings[0].level, "info");
  assert.equal(elsewhere.exit, 0);

  rmSync(join(a.root, ".house", "planted.json"));
  const unfinished = doctor(a.env, a.root);
  assert.deepEqual(codes(unfinished), ["SETUP_UNFINISHED"]);
  assert.equal(unfinished.exit, exitOf("SETUP_UNFINISHED"));
  assert.equal(unfinished.exit, 3);
});

test("house-toml: a schema violation, a newer house.schema and a newer [plugin] min", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  const original = readText(join(root, "house.toml"));

  writeFileSync(join(root, "house.toml"), `${original}\n[bogus]\nkey = 1\n`);
  const invalid = doctor(env, root);
  assert.ok(codes(invalid).includes("HOUSE_TOML_INVALID"), JSON.stringify(invalid.findings));
  assert.equal(invalid.exit, 2);

  writeFileSync(join(root, "house.toml"), original.replace("schema = 1", "schema = 2"));
  const newer = doctor(env, root);
  assert.deepEqual(codes(newer), ["HOUSE_SCHEMA_NEWER"]);
  assert.equal(newer.exit, 2);

  // init writes this plugin's own version as the minimum; any version above it must be refused.
  writeFileSync(join(root, "house.toml"), original.replace(/^min = "[^"]*"$/m, 'min = "99.0.0"'));
  const tooOld = doctor(env, root);
  assert.ok(codes(tooOld).includes("PLUGIN_TOO_OLD"), JSON.stringify(tooOld.findings));
  assert.equal(tooOld.exit, 2);
});

test("house-toml: an older house.schema is fixable by lampstand upgrade", SLOW, (t) => {
  // house.schema 1 is the oldest a house can declare today, so the older state is set on the gathered facts.
  const { env, root } = plantHouse(t);
  const { facts } = doctor(env, root);
  const house = /** @type {NonNullable<typeof facts.house>} */ (facts.house);
  assert.ok(house.config.ok);
  const report = runChecks({ ...facts, house: { ...house, config: { ...house.config, schema: 0 } } }, { quick: false });
  assert.deepEqual(codes(report), ["HOUSE_SCHEMA_OLDER"]);
  assert.equal(report.findings[0].fix, "lampstand upgrade");
  assert.equal(report.exit, 1);
});

test("projections: an edited input, a deleted projection, an edited region, and an unreadable constitution", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  edit(root, "voice.md", /$/, "\nAlways sign off.\n");
  const stale = doctor(env, root);
  assert.ok(codes(stale).includes("PROJECTION_STALE"), JSON.stringify(stale.findings));
  assert.equal(stale.exit, 1);

  const fresh = plantHouse(t);
  rmSync(join(fresh.root, ".house", "generated", "watchdog.md"));
  const missing = doctor(fresh.env, fresh.root);
  assert.deepEqual(codes(missing), ["PROJECTION_MISSING"]);
  assert.equal(missing.exit, 1);

  const region = plantHouse(t);
  edit(region.root, "AGENTS.md", "<!-- house:end -->", "hand-written line\n<!-- house:end -->");
  const regionStale = doctor(region.env, region.root);
  assert.deepEqual(codes(regionStale), ["REGION_STALE"]);
  assert.equal(regionStale.exit, 1);

  const broken = plantHouse(t);
  plant(broken.root, { "principles/broken.md": "---\norigin: [own\n---\n### X : Broken\n" });
  const unreadable = doctor(broken.env, broken.root);
  assert.ok(codes(unreadable).includes("CONSTITUTION_INVALID"), JSON.stringify(unreadable.findings));
  assert.equal(unreadable.exit, 2);
});

test("budgets: a kernel over the host envelope", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  const asks = Array.from({ length: 30 }, (_, k) => `"Ask before step ${k} of every release that touches the shared billing records."`);
  edit(root, "house.toml", 'ask_first = ["Ask before pushing to any remote."]', `ask_first = [${asks.join(", ")}]`);
  const report = doctor(env, root);
  const over = report.findings.filter((finding) => finding.code === "BUDGET_OVER_ENVELOPE");
  assert.equal(over.length, 1, JSON.stringify(report.findings));
  assert.match(over[0].message, /^kernel is \d+ chars; hosts load at most 4000$/);
  assert.equal(report.exit, 2);
});

test("state-db: a house.db from a newer lampstand, and one that is not a database", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  stateRun(root, env, "UPDATE meta SET value = '99' WHERE key = 'schema_version'");
  const newer = doctor(env, root);
  assert.deepEqual(codes(newer), ["STATE_DB_NEWER"]);
  assert.equal(newer.exit, 2);

  const other = plantHouse(t);
  const dir = stateDir(other.root, other.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "house.db"), "this is not a database, it is a sentence long enough to fill a header page".repeat(20));
  const unreadable = doctor(other.env, other.root);
  assert.deepEqual(codes(unreadable), ["STATE_DB_UNREADABLE"]);
  assert.equal(unreadable.exit, 2);
});

test("state-local: a state directory inside the house, inside a synced folder, and a relative override", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  const id = loadHouseConfig(root).house.id;
  const config = join(String(env.LAMPSTAND_CONFIG_ROOT), "lampstand", "config.toml");
  /** @param {string} value */
  const override = (value) => plant(join(String(env.LAMPSTAND_CONFIG_ROOT), "lampstand"), { "config.toml": `[houses."${id}"]\nstate_dir = ${JSON.stringify(value)}\n` });

  override(join(root, "machine").split("\\").join("/"));
  const inside = doctor(env, root);
  assert.deepEqual(codes(inside), ["STATE_DIR_NOT_LOCAL"]);
  assert.match(inside.findings[0].message, /inside the house/);
  assert.equal(inside.exit, 2);

  rmSync(config);
  const synced = doctor({ ...env, OneDrive: String(env.LAMPSTAND_STATE_ROOT) }, root);
  assert.deepEqual(codes(synced), ["STATE_DIR_NOT_LOCAL"]);
  assert.equal(synced.exit, 2);

  override("relative/state");
  const invalid = doctor(env, root);
  assert.deepEqual(codes(invalid), ["STATE_DIR_INVALID"]);
  assert.equal(invalid.exit, 2);
});

test("jobs: a job that never landed with no OS entry, a rejected and a not-landed run, an entry for another house, a broken ledger", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  schedulerOn(root);
  const missing = doctor(env, root, { schedulerHost: schedulerHost(env, 1) });
  assert.deepEqual(codes(missing).sort(), ["JOB_STALE", "TICK_ENTRY_MISSING"]);
  assert.equal(missing.exit, 1);

  const here = schedulerHost(env, 0, `<Exec><Arguments>tick --house ${root}</Arguments></Exec>`);
  const now = new Date().toISOString();
  stateRun(root, env, "INSERT INTO job_runs (job, started_at, finished_at, outcome, detail, run_id) VALUES ('check', ?, ?, 'landed', '', 'a')", now, now);
  assert.deepEqual(codes(doctor(env, root, { schedulerHost: here })), []);

  stateRun(root, env, "INSERT INTO job_runs (job, started_at, finished_at, outcome, detail, run_id) VALUES ('check', ?, ?, 'not_landed', 'HEAD carried other paths', 'b')", now, now);
  const notLanded = doctor(env, root, { schedulerHost: here });
  assert.deepEqual(codes(notLanded), ["JOB_NOT_LANDED"]);
  assert.equal(notLanded.exit, 1);

  stateRun(root, env, "INSERT INTO job_runs (job, started_at, finished_at, outcome, detail, run_id) VALUES ('check', ?, ?, 'rejected', 'staged notes.md outside outputs', 'c')", now, now);
  const rejected = doctor(env, root, { schedulerHost: here });
  assert.deepEqual(codes(rejected), ["JOB_REJECTED"]);
  assert.equal(rejected.exit, 2);

  if (process.platform === "win32") {
    // A Task Scheduler entry's definition is the task XML; its arguments must name this house.
    const other = doctor(env, root, { schedulerHost: schedulerHost(env, 0, "<Exec><Arguments>tick --house C:/another</Arguments></Exec>") });
    assert.ok(codes(other).includes("TICK_ENTRY_ELSEWHERE"), JSON.stringify(other.findings));
  }

  const key = tickKey(root, loadHouseConfig(root).house.id);
  recordSeat(env, { id: `scheduler:${key}:schtasks:${key}`, owner: "scheduler", house: join(root, "..", "elsewhere"), kind: "schtasks", target: key, before: null });
  const elsewhere = doctor(env, root, { schedulerHost: here });
  assert.ok(codes(elsewhere).includes("TICK_ENTRY_ELSEWHERE"), JSON.stringify(elsewhere.findings));

  writeFileSync(join(String(env.LAMPSTAND_CONFIG_ROOT), "lampstand", "seat.json"), "{");
  const ledger = doctor(env, root, { schedulerHost: here });
  assert.ok(codes(ledger).includes("SEAT_LEDGER_INVALID"), JSON.stringify(ledger.findings));
  assert.equal(ledger.exit, 2);
});

test("runtimes: neither node nor bun, and no git, on PATH; bun alone is enough", SLOW, (t) => {
  const { dir, env, root } = plantHouse(t);
  rmSync(join(dir, "bin", exe("node")));
  rmSync(join(dir, "bin", exe("git")));
  const missing = doctor(env, root);
  assert.deepEqual(codes(missing), ["RUNTIME_MISSING", "GIT_MISSING"]);
  assert.equal(missing.exit, 2);

  writeFileSync(join(dir, "bin", exe("bun")), "");
  assert.deepEqual(codes(doctor(env, root)), ["GIT_MISSING"]);
});

test("proposals: a waiting proposal is information and leaves the house healthy", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  plant(root, { "proposals/reflexes/read-first.md": "---\noccasion: an edit missed a line\n---\nRead the file before editing it.\n" });
  const report = doctor(env, root);
  assert.deepEqual(report.findings.map((finding) => [finding.code, finding.level, finding.message]), [
    ["PROPOSALS_WAITING", "info", "1 proposal waiting: proposals/reflexes/read-first.md"],
  ]);
  assert.equal(report.exit, 0);
});
