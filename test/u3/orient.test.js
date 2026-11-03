// @ts-check
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inputHash, readInputs } from "../../core/lib/constitution/house.js";
import { capLines, orient } from "../../core/lib/orient.js";
import { openStateDb } from "../../core/lib/state/db.js";
import { stateDirFor } from "../../core/lib/state/paths.js";
import { HOUSE_ID, cli, cliJson, makeHouse, plant } from "./helpers.js";

const task = (/** @type {string} */ status) => `---\nkind: task\ntitle: T\nstatus: ${status}\ncreated: "2026-01-01"\n---\n`;

test("counts per kind and status, in schema order, and nothing else on a healthy house", async (t) => {
  const house = makeHouse(t, {
    files: {
      "tasks/a.md": task("open"),
      "tasks/b.md": task("active"),
      "tasks/c.md": task("open"),
      "tasks/resolved/d.md": task("done"),
      "tasks/broken.md": "---\nkind: [\n---\n",
      "inbox/decisions/x.md": '---\nkind: decision\ntitle: X\nstatus: open\ncreated: "2026-01-01"\n---\n',
    },
  });
  const { code, stdout } = await cli(["status", "--orient"], house);
  assert.equal(code, 0);
  assert.equal(stdout, "task 5: open 2, active 1, done 1, (unparsed) 1\ndecision 1: open 1\n");
  assert.equal((await cli(["status"], makeHouse(t))).stdout, "org: no items\n");
});

test("a projection whose manifest input hash no longer matches is reported; a fresh one is not", async (t) => {
  const house = makeHouse(t, { files: { "principles/p.md": "# P\n" } });
  plant(house.root, { ".house/generated/manifest.json": JSON.stringify({ "input-hash": inputHash(readInputs(house.root)) }) });
  assert.deepEqual(orient(house.root, { env: house.env }).problems, []);
  plant(house.root, { "principles/p.md": "# P changed\n" });
  const problems = orient(house.root, { env: house.env }).problems;
  assert.deepEqual(problems.map((p) => [p.code, p.subject]), [["STALE_PROJECTION", ".house/generated"]]);
  assert.match(problems[0].message, /run lampstand compile$/);
});

test("a house.schema newer than the code is a problem line, and counts still print", async (t) => {
  const house = makeHouse(t, { files: { "tasks/a.md": task("open") } });
  plant(house.root, { "house.toml": `[house]\nschema = 99\nid = "${HOUSE_ID}"\nname = "x"\n` });
  const { code, body } = await cliJson(["status", "--orient"], house);
  assert.equal(code, 0);
  assert.deepEqual(body.problems.map((/** @type {any} */ p) => p.code), ["SCHEMA_NEWER"]);
  assert.match(body.text, /^task 1: open 1\nSCHEMA_NEWER house\.toml: .*house\.schema = 99 is newer/);
});

/** @param {string[]} ids @param {number} staleHours */
const jobsToml = (ids, staleHours) => ids.map((id) => `[jobs.${id}]\nargv = ["node"]\nstale_hours = ${staleHours}\n`).join("");

test("job health from job_runs: STALE, NOT_LANDED and REJECTED are reported, OK is not", async (t) => {
  const house = makeHouse(t, { toml: jobsToml(["fresh", "nightly", "pusher", "check", "never"], 24) });
  const state = openStateDb(stateDirFor(house.root, HOUSE_ID, house.env).dir);
  const now = Date.now();
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  try {
    const insert = (/** @type {string} */ job, /** @type {number} */ at, /** @type {string} */ outcome, /** @type {string} */ detail) =>
      state.db.run(
        "INSERT INTO job_runs (job, started_at, finished_at, outcome, detail, run_id) VALUES (?, ?, ?, ?, ?, ?)",
        job, iso(at), iso(at), outcome, detail, `${job}-${at}-${outcome}`,
      );
    insert("fresh", now - 3_600_000, "landed", "");
    insert("nightly", now - 72 * 3_600_000, "landed", "");
    insert("pusher", now - 3_600_000, "not_landed", "push refused");
    insert("check", now - 3_600_000, "rejected", "wrote outside outputs");
  } finally {
    state.db.close();
  }
  const problems = orient(house.root, { env: house.env, now }).problems;
  assert.deepEqual(
    problems.map((p) => `${p.code} ${p.subject}`),
    ["REJECTED job check", "STALE job never", "STALE job nightly", "NOT_LANDED job pusher"],
  );
  assert.match(problems[1].message, /^never landed; stale after 24h$/);
  assert.match(problems[3].message, /push refused$/);
});

test("orientation never creates house.db", async (t) => {
  const house = makeHouse(t, { toml: jobsToml(["check"], 24) });
  const dir = stateDirFor(house.root, HOUSE_ID, house.env).dir;
  assert.deepEqual(orient(house.root, { env: house.env }).problems, []);
  assert.equal(existsSync(join(dir, "house.db")), false);
});

test("capLines keeps whole lines within the cap and says how many it left out", () => {
  const lines = Array.from({ length: 50 }, (_, k) => `line ${k} ${"x".repeat(40)}`);
  const { text, omitted } = capLines(lines, 500);
  assert.ok([...text].length <= 500);
  const kept = text.split("\n");
  assert.equal(kept.length - 1 + omitted, 50);
  assert.equal(kept.at(-1), `(${omitted} more lines left out; run lampstand status for all of them)`);
  assert.deepEqual(capLines(["a", "b"], 3), { text: "a\nb", omitted: 0 });
});

// Writing 5,000 files takes seconds on a loaded machine; bun's default 5 s per test is too short for it.
test("status --orient stays within 2,000 chars on a house with 5,000 tasks and 300 unhealthy jobs", { timeout: 120_000 }, async (t) => {
  const ids = Array.from({ length: 300 }, (_, k) => `job-${String(k).padStart(3, "0")}`);
  const house = makeHouse(t, { toml: jobsToml(ids, 1) });
  const dir = join(house.root, "tasks");
  mkdirSync(join(dir, "resolved"), { recursive: true });
  for (let k = 0; k < 5000; k++) {
    if (k % 10 === 0) writeFileSync(join(dir, "resolved", `t${k}.md`), task("done"));
    else writeFileSync(join(dir, `t${k}.md`), task(k % 3 === 0 ? "active" : "open"));
  }
  openStateDb(stateDirFor(house.root, HOUSE_ID, house.env).dir).db.close();
  const { code, body } = await cliJson(["status", "--orient"], house);
  assert.equal(code, 0);
  assert.equal(body.cap, 2000);
  assert.ok([...body.text].length <= 2000, `${[...body.text].length} chars`);
  assert.deepEqual(body.counts.task, { open: 3000, active: 1500, done: 500 });
  assert.equal(body.text.split("\n")[0], "task 5000: open 3000, active 1500, done 500");
  assert.ok(body.omitted > 0);
  assert.match(body.text, new RegExp(`\\n\\(${body.omitted} more lines left out; run lampstand status for all of them\\)$`));
  assert.equal(body.problems.length, 300);
});

test("a lean house holds orientation to the lean budget", async (t) => {
  const house = makeHouse(t, { toml: `[budget]\nprofile = "lean"\n${jobsToml(Array.from({ length: 100 }, (_, k) => `j${k}`), 1)}` });
  openStateDb(stateDirFor(house.root, HOUSE_ID, house.env).dir).db.close();
  const { body } = await cliJson(["status", "--orient"], house);
  assert.equal(body.cap, 1000);
  assert.ok([...body.text].length <= 1000);
});
