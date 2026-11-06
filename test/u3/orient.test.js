// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inputHash, readInputs } from "../../core/lib/constitution/house.js";
import { capLines, NAMED, NOTHING_OPEN, orient } from "../../core/lib/orient.js";
import { openStateDb } from "../../core/lib/state/db.js";
import { stateDirFor } from "../../core/lib/state/paths.js";
import { HOUSE_ID, cli, cliJson, makeHouse, plant } from "./helpers.js";

const task = (/** @type {string} */ status) => `---\nkind: task\ntitle: T\nstatus: ${status}\ncreated: "2026-01-01"\n---\n`;

test("status leads with counts per kind and status, in schema order; an empty house says so in plain words", async (t) => {
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
  const { code, stdout } = await cli(["status"], house);
  assert.equal(code, 0);
  assert.match(stdout, /^task 5: open 2, active 1, done 1, \(unparsed\) 1\ndecision 1: open 1\n/);
  assert.equal((await cli(["status"], makeHouse(t))).stdout, `${NOTHING_OPEN}\n`);
  assert.equal((await cli(["status", "--orient"], makeHouse(t))).stdout, `${NOTHING_OPEN}\n`);
});

test("orientation names what needs attention: open tasks overdue first, decisions, reminders due, and the rest counted", async (t) => {
  /** @param {string} kind @param {string} title @param {string} status @param {string} [due] */
  const item = (kind, title, status, due) => `---\nkind: ${kind}\ntitle: ${title}\nstatus: ${status}\ncreated: "2026-01-01"\n${due ? `due: "${due}"\n` : ""}---\n`;
  const house = makeHouse(t, {
    files: {
      "tasks/catalog.md": item("task", "Draft catalog copy", "open"),
      "tasks/galley.md": item("task", "Send galley proofs", "open", "2001-11-01"),
      "tasks/quotes.md": item("task", "Request printer quotes", "active", "2999-01-01"),
      "tasks/resolved/old.md": `${item("task", "Old work", "done").slice(0, -4)}resolved: "2026-01-02"\nresolution: "[[x]]"\n---\n`,
      "inbox/decisions/reissue.md": item("decision", "Reissue the hardcover?", "open"),
      "reminders/statements.md": item("reminder", "Send statements", "open", "2001-11-03"),
      "reminders/renew.md": item("reminder", "Renew the domain", "open", "2999-06-01"),
      "inbox/captures/c.md": "---\nkind: capture\ncreated: \"2026-01-01\"\n---\nA thought\n",
      "knowledge/k.md": item("knowledge", "How releases work", "current"),
    },
  });
  const { code, body } = await cliJson(["status", "--orient"], house);
  assert.equal(code, 0);
  assert.equal(
    body.text,
    [
      "Open tasks (3, 1 overdue):",
      "- Send galley proofs (due 2001-11-01, overdue)",
      "- Request printer quotes (active; due 2999-01-01)",
      "- Draft catalog copy",
      "Decisions waiting for the operator's ruling (1):",
      "- Reissue the hardcover?",
      "Reminders due (1):",
      "- Send statements (due 2001-11-03, overdue)",
      "Also open: 1 capture, 1 knowledge.",
    ].join("\n"),
  );
  assert.deepEqual(body.attention.tasks.map((/** @type {any} */ named) => [named.id, named.overdue]), [["galley", true], ["quotes", false], ["catalog", false]]);
  assert.equal(body.uncommitted, null, "a house that is not a git repository has no uncommitted count");
  assert.equal(body.text.includes("Old work"), false, "a resolved task is not named");
});

test("orientation names at most a few of each and counts the rest", (t) => {
  /** @type {Record<string, string>} */
  const files = {};
  for (let k = 0; k < NAMED.tasks + 3; k++) files[`tasks/t${String(k).padStart(2, "0")}.md`] = `---\nkind: task\ntitle: Task ${k}\nstatus: open\ncreated: "2026-01-01"\n---\n`;
  const house = makeHouse(t, { files });
  const { lines, attention } = orient(house.root, { env: house.env });
  assert.equal(attention.tasks.length, NAMED.tasks + 3);
  assert.equal(lines.filter((line) => line.startsWith("- Task ")).length, NAMED.tasks);
  assert.ok(lines.includes("- and 3 more (lampstand task list)"));
});

test("orientation counts the changes not yet committed in a git house", (t) => {
  const house = makeHouse(t, { files: { "tasks/a.md": task("open") } });
  /** @param {string[]} args */
  const git = (...args) => {
    const result = spawnSync("git", ["-C", house.root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  assert.equal(orient(house.root, { env: house.env }).uncommitted, 0);
  plant(house.root, { "tasks/a.md": task("active"), "projects/new.md": "x\n" });
  const found = orient(house.root, { env: house.env });
  assert.equal(found.uncommitted, 2);
  assert.ok(found.lines.includes("2 changes in the house not yet committed."));
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
  assert.match(body.text, /^Open tasks \(1\):\n- T\nSCHEMA_NEWER house\.toml: .*house\.schema = 99 is newer/);
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
  assert.equal(body.text.split("\n")[0], "Open tasks (4500):");
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
