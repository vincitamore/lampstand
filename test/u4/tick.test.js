// @ts-check
import { localDate } from "../../core/lib/org/markdown.js";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "../../core/lib/frontmatter.js";
import { openHouseDb } from "../../core/lib/governance/run.js";
import { tick } from "../../core/lib/scheduler/tick.js";
import { HOUSE_TOML } from "../u1/helpers.js";
import { SPAWNS, envelope, jobArgv, lampstand, makeHouse, plantedHouse, tempDir } from "./helpers.js";

const ON = "[modules]\nscheduler = true\n";

/** @param {string} root */
function captures(root) {
  try {
    return readdirSync(join(root, "inbox", "captures")).sort();
  } catch {
    return [];
  }
}

/** @param {ReturnType<typeof makeHouse>} made @param {string} sql @param {import("../../core/lib/state/sqlite.js").SqlValue[]} params */
function query(made, sql, ...params) {
  const state = openHouseDb(made.house(), made.env);
  try {
    return state.db.once(sql, (statement) => statement.all(...params));
  } finally {
    state.db.close();
  }
}

test("tick runs a job that missed several intervals once, then not again until it is due", async (t) => {
  const dir = tempDir(t);
  const made = makeHouse(dir, `${ON}[jobs.hourly]\nargv = ${jobArgv()}\nstale_hours = 2\nevery = "1h"\n[jobs.manual]\nargv = ${jobArgv()}\nstale_hours = 2\n`);
  const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
  query(made, "INSERT INTO job_runs (job, started_at, finished_at, outcome, run_id) VALUES ('hourly', ?, ?, 'landed', 'old') RETURNING id", fiveHoursAgo, fiveHoursAgo);

  const first = await tick({ house: made.house(), env: made.env, doctor: null });
  assert.deepEqual(first.ran.map((run) => [run.job, run.outcome]), [["hourly", "landed"]]);
  const second = await tick({ house: made.house(), env: made.env, doctor: null });
  assert.deepEqual(second.ran, []);
  assert.deepEqual(
    query(made, "SELECT job, trigger FROM job_runs WHERE run_id <> 'old'").map((row) => [row.job, row.trigger]),
    [["hourly", "tick"]],
  );
});

test("lampstand tick is silent on success and does nothing while the scheduler module is off", SPAWNS, (t) => {
  const dir = tempDir(t);
  const on = plantedHouse(join(dir, "on"), `${ON}[jobs.often]\nargv = ${jobArgv()}\nstale_hours = 1\nevery = "1m"\n`);
  const quiet = lampstand(["tick"], { cwd: on.root, env: on.env });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
  assert.equal(quiet.stderr, "");
  assert.equal(query(on, "SELECT count(*) AS n FROM job_runs")[0].n, 1);

  const off = makeHouse(join(dir, "off"), `[jobs.often]\nargv = ${jobArgv()}\nstale_hours = 1\nevery = "1m"\n`);
  const result = lampstand(["tick", "--json", "--house", off.root], { cwd: dir, env: off.env });
  assert.equal(result.status, 0);
  assert.deepEqual(envelope(result.stdout), { ok: true, house: off.root, active: false, ran: [], doctor: "absent", failures: [], capture: null, text: "" });
  assert.equal(query(off, "SELECT count(*) AS n FROM job_runs")[0].n, 0);
});

test("a failing tick writes one capture; the same failure again writes none; after a success it writes again", SPAWNS, (t) => {
  const dir = tempDir(t);
  const failing = `${ON}[jobs.flaky]\nargv = ${jobArgv("exit:2")}\nstale_hours = 1\nevery = "1m"\n`;
  const made = plantedHouse(dir, failing);
  const once = lampstand(["tick"], { cwd: made.root, env: made.env });
  assert.equal(once.status, 1);
  assert.match(once.stdout, /job flaky: failed: exited with 2/);
  const [first] = captures(made.root);
  assert.match(first, /^\d{8}-\d{4}-tick-failure\.md$/);
  const text = readFileSync(join(made.root, "inbox", "captures", first), "utf8");
  const parsed = parseFrontmatter(text, first);
  assert.deepEqual(parsed.frontmatter, { kind: "capture", created: localDate(), source: "lampstand tick" });
  assert.match(parsed.body, /- job flaky: failed: exited with 2/);

  const again = lampstand(["tick", "--json"], { cwd: made.root, env: made.env });
  assert.equal(again.status, 1);
  assert.equal(envelope(again.stdout).capture, null);
  assert.equal(captures(made.root).length, 1);

  // house.toml is an input to the compiled projections, so each edit is followed by a compile, as in a real house;
  // otherwise doctor --quick rightly reports them stale and the tick is not a success.
  const compile = () => assert.equal(lampstand(["compile"], { cwd: made.root, env: made.env }).status, 0);
  writeFileSync(join(made.root, "house.toml"), `${HOUSE_TOML}${failing.replace("'exit:2'", "'sleep:1'")}`);
  compile();
  assert.equal(lampstand(["tick"], { cwd: made.root, env: made.env }).status, 0);
  writeFileSync(join(made.root, "house.toml"), `${HOUSE_TOML}${failing}`);
  compile();
  // Two ticks inside one minute share a capture name stem; the second gets a numbered one.
  assert.equal(lampstand(["tick"], { cwd: made.root, env: made.env }).status, 1);
  assert.equal(captures(made.root).length, 2);
});

test("tick runs doctor --quick when a doctor exists and treats its failure like a job's", async (t) => {
  const dir = tempDir(t);
  const made = makeHouse(dir, ON);
  /** @type {string[]} */
  const calls = [];
  const sick = await tick({
    house: made.house(),
    env: made.env,
    doctor: async ({ root }) => {
      calls.push(root);
      return { ok: false, detail: "hook missing" };
    },
  });
  assert.deepEqual(calls, [made.root]);
  assert.equal(sick.doctor, "failed");
  assert.deepEqual(sick.failures, ["doctor --quick: hook missing"]);
  assert.equal(sick.capture, captures(made.root).map((name) => `inbox/captures/${name}`)[0]);

  const well = await tick({ house: made.house(), env: made.env, doctor: async () => ({ ok: true, detail: "" }) });
  assert.deepEqual([well.doctor, well.failures, well.capture], ["ok", [], null]);
  const absent = await tick({ house: made.house(), env: made.env, doctor: null });
  assert.equal(absent.doctor, "absent");
});
