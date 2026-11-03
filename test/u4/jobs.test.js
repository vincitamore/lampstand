// @ts-check
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isLampstandError } from "../../core/lib/errors.js";
import { nextOccurrence, parseCron } from "../../core/lib/governance/cron.js";
import { DUE_SLACK_MS, isDue, loadHouse } from "../../core/lib/governance/jobs.js";
import { HOUSE_TOML, REPO, plant } from "../u1/helpers.js";
import { tempDir } from "./helpers.js";

/** @param {import("node:test").TestContext} t @param {string} jobs */
function houseWith(t, jobs) {
  const root = join(tempDir(t), "house");
  plant(root, { "house.toml": `${HOUSE_TOML}${jobs}` });
  return root;
}

/** @param {string} reason */
const schemaError = (reason) => (/** @type {unknown} */ error) =>
  isLampstandError(error) && error.code === "E_SCHEMA" && error.message.includes("house.toml") && error.message.includes(reason);

test("job declarations that cannot be honoured are refused with E_SCHEMA naming house.toml and the key", (t) => {
  const cases = [
    ['argv = ["x"]\nstale_hours = 1\noutputs = ["../escape/"]', "jobs.j.outputs.0"],
    ['argv = ["x"]\nstale_hours = 1\noutputs = ["a/.git/hooks/"]', "enters .git"],
    ['argv = ["x"]\nstale_hours = 1\nmutates = ["a/./b.md"]', "jobs.j.mutates.0"],
    ['argv = ["x"]\nstale_hours = 1\noutputs = ["/abs/"]', "must match"],
    ['argv = []\nstale_hours = 1', "must name a program"],
    ['argv = ["x"]\nstale_hours = 1\nevery = "1h"\nat = "02:00"', "cannot be combined with every"],
    ['argv = ["x"]\nstale_hours = 1\ncron = "61 * * * *"', "outside 0-59"],
    ['argv = ["x"]\nstale_hours = 1\ncron = "0 0 31 2 *"', "never fires"],
    ['argv = ["x"]\nstale_hours = 1\ncommit = "force"', "must be one of"],
    ['argv = ["x"]', "missing required key stale_hours"],
    ['argv = ["x"]\nstale_hours = 1\nenv = ["A-B"]', "jobs.j.env[0]"],
  ];
  for (const [body, reason] of cases) {
    const root = houseWith(t, `[jobs.j]\n${body}\n`);
    assert.throws(() => loadHouse(root), schemaError(reason), body);
  }
  assert.throws(() => loadHouse(houseWith(t, '[jobs.Bad_Id]\nargv = ["x"]\nstale_hours = 1\n')), schemaError("not a valid job id"));
});

test("a house declaring a newer house.schema is refused as newer, not for its jobs table", (t) => {
  const root = join(tempDir(t), "house");
  plant(root, { "house.toml": `${HOUSE_TOML.replace("schema = 1", "schema = 99")}[jobs.j]\nargv = ["x"]\nstale_hours = 1\nfuture = 1\n` });
  assert.throws(() => loadHouse(root), (/** @type {any} */ e) => isLampstandError(e) && e.code === "E_SCHEMA_NEWER");
});

test("every starter job template is a valid [jobs] declaration", (t) => {
  const dir = join(REPO, "templates", "jobs");
  const names = readdirSync(dir).filter((name) => name.endsWith(".toml"));
  assert.deepEqual(names.sort(), ["check.toml", "doctor.toml"]);
  const root = houseWith(t, names.map((name) => readFileSync(join(dir, name), "utf8")).join("\n"));
  const jobs = loadHouse(root).jobs;
  assert.deepEqual(jobs.get("check")?.argv, ["lampstand", "check"]);
  assert.deepEqual(jobs.get("doctor")?.argv, ["lampstand", "doctor", "--quick"]);
  for (const job of jobs.values()) assert.equal(job.commit, false, `${job.id} must not commit or push by default`);
});

test("cron fields: steps, ranges, lists, Sunday as 0 or 7, and either day field matching when both are restricted", () => {
  const at = (/** @type {string} */ spec, /** @type {Date} */ from) => nextOccurrence(parseCron(spec), from)?.toString();
  const from = new Date(2026, 10, 2, 10, 7); // Monday 2 November 2026, 10:07 local
  assert.equal(at("*/15 * * * *", from), new Date(2026, 10, 2, 10, 15).toString());
  assert.equal(at("0 2 * * *", from), new Date(2026, 10, 3, 2, 0).toString());
  assert.equal(at("30 9-17/4 * * *", from), new Date(2026, 10, 2, 13, 30).toString());
  assert.equal(at("0 0 * * 7", from), new Date(2026, 10, 8, 0, 0).toString());
  assert.equal(at("0 0 * * 0", from), new Date(2026, 10, 8, 0, 0).toString());
  // Day 15 or a Wednesday, whichever comes first.
  assert.equal(at("0 12 15 * 3", from), new Date(2026, 10, 4, 12, 0).toString());
  assert.equal(at("0 0 29 2 *", from), new Date(2028, 1, 29, 0, 0).toString());
  assert.equal(at("7 10 2 11 *", from), new Date(2027, 10, 2, 10, 7).toString(), "strictly after, never the same minute");
  assert.throws(() => parseCron("@daily"), /5 fields/);
  assert.throws(() => parseCron("0 0 * JAN *"), /month field/);
});

test("due: an every job is due once its interval (less the slack) has passed; a missed schedule runs once", (t) => {
  const job = loadHouse(houseWith(t, '[jobs.e]\nargv = ["x"]\nstale_hours = 1\nevery = "15m"\n[jobs.c]\nargv = ["x"]\nstale_hours = 1\nat = "02:00"\n[jobs.m]\nargv = ["x"]\nstale_hours = 1\n')).jobs;
  const every = /** @type {any} */ (job.get("e"));
  const daily = /** @type {any} */ (job.get("c"));
  const now = new Date(2026, 10, 2, 10, 0).getTime();
  const minutes = (/** @type {number} */ n) => n * 60_000;
  assert.equal(isDue(every, null, now, now), true, "never run: due");
  assert.equal(isDue(every, now - minutes(15) + DUE_SLACK_MS / 2, now, now), true, "a tick a little early still runs it");
  assert.equal(isDue(every, now - minutes(10), now, now), false);
  // Last run three days ago at 02:05: three 02:00s were missed; one run is due, and after it, none until tomorrow.
  const threeDaysAgo = new Date(2026, 9, 30, 2, 5).getTime();
  assert.equal(isDue(daily, threeDaysAgo, now, now), true);
  assert.equal(isDue(daily, now, now, now), false);
  assert.equal(isDue(daily, null, new Date(2026, 10, 2, 1, 50).getTime(), new Date(2026, 10, 2, 2, 5).getTime()), true, "never run: due when its time fell since the last tick");
  assert.equal(isDue(daily, null, now - minutes(15), now), false, "never run: not due when its time did not fall since the last tick");
  assert.equal(isDue(/** @type {any} */ (job.get("m")), null, 0, now), false, "a job without a schedule runs only by hand");
});
