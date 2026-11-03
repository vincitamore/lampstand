// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { cli, cliJson, makeHouse, plant, read } from "./helpers.js";

const STAMPED = /^- [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z \| /;

test("forge log refuses an entry that carries its own timestamp and leaves the log untouched", async (t) => {
  const house = makeHouse(t);
  const created = await cliJson(["forge", "new", "Port the parser", "--stages", "plan, build,review"], house);
  assert.equal(created.code, 0);
  const rel = created.body.path;
  assert.match(rel, /^forge\/sessions\/[0-9]{8}-[0-9]{4}-port-the-parser\.md$/);
  const before = read(house.root, rel);
  for (const entry of [
    "2026-11-02T10:00:00Z | planner done",
    "- 2026-11-02 10:00 | planner done",
    "built at 2026-11-02T10:00 by worker",
    "10:42 tests green",
    "[Mon 10:42] tests green",
    "2026-11-02: tests green",
    "two\nlines",
    "  ",
  ]) {
    const { code, body } = await cliJson(["forge", "log", rel, entry], house);
    assert.equal(code, 64, JSON.stringify(entry));
    assert.equal(body.error.code, "E_USAGE");
  }
  assert.equal(read(house.root, rel), before);
  // A bare date inside the text is content (a deadline, a version), not a timestamp.
  assert.equal((await cliJson(["forge", "log", rel, "deadline moved to 2026-12-01"], house)).code, 0);
});

test("forge log appends at the end of the execution log, never under a later heading", async (t) => {
  const house = makeHouse(t);
  const rel = (await cliJson(["forge", "new", "Pipeline"], house)).body.path;
  const first = await cliJson(["forge", "log", rel, "planner: drafted the plan"], house);
  assert.equal(first.code, 0);
  assert.match(first.body.line, STAMPED);

  // Someone adds a later section after the log; entries must still land inside the log, after the last one.
  plant(house.root, { [rel]: `${read(house.root, rel)}\n## Notes\n\nfree text\n- not a log line\n` });
  await cli(["forge", "log", rel, "builder: compiled"], house);
  await cli(["forge", "log", rel.replace(/^forge\/sessions\//, "").replace(/\.md$/, ""), "reviewer: approved"], house);

  const lines = read(house.root, rel).split("\n");
  const log = lines.indexOf("## Execution log");
  const notes = lines.indexOf("## Notes");
  const entries = lines.slice(log + 1, notes).filter((line) => line !== "");
  assert.deepEqual(entries.map((line) => line.replace(STAMPED, "")), ["planner: drafted the plan", "builder: compiled", "reviewer: approved"]);
  assert.ok(entries.every((line) => STAMPED.test(line)));
  assert.equal(lines[notes - 1], "", "one blank line separates the log from the next heading");
  assert.deepEqual(lines.slice(notes), ["## Notes", "", "free text", "- not a log line", ""]);

  const status = await cliJson(["forge", "status", rel], house);
  assert.equal(status.body.session.entries.length, 3);
  assert.deepEqual(status.body.session.stages, []);
});

test("forge log on the last section keeps the file ending in one newline; status lists sessions", async (t) => {
  const house = makeHouse(t);
  const rel = (await cliJson(["forge", "new", "Solo", "--stages", "a,b"], house)).body.path;
  await cli(["forge", "log", rel, "one"], house);
  await cli(["forge", "log", rel, "two"], house);
  const text = read(house.root, rel);
  assert.ok(text.endsWith(" | two\n") && !text.endsWith("\n\n"));
  assert.match(text, /## Pipeline\n\n- \[ \] a\n- \[ \] b\n\n## Execution log\n\n- .* \| one\n- .* \| two\n$/);
  const listed = await cliJson(["forge", "status"], house);
  assert.deepEqual(listed.body.sessions.map((/** @type {any} */ s) => [s.path, s.stages, s.entries.length]), [[rel, ["a", "b"], 2]]);
  assert.equal((await cliJson(["forge", "log", "missing", "x"], house)).code, 64);
});
