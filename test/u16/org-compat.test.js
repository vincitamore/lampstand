// @ts-check
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isLampstandError } from "../../core/lib/errors.js";
import { scanItems, transition } from "../../core/lib/org/items.js";
import { loadOrgSchema } from "../../core/lib/org/schema.js";
import { cliJson, makeHouse, read } from "../u3/helpers.js";

/** A house that predates lampstand: `type:` names the kind, titles are headings, a folder per task status. */
const COMPAT = [
  "[org]",
  'kind_field = "type"',
  'title_fallback = "heading"',
  "[org.kinds.task]",
  'statuses = ["review", "complete"]',
  'terminal = ["complete"]',
  'lists = ["blocked-by"]',
  "[org.kinds.task.status_folders]",
  'review = "tasks/review"',
  'complete = "tasks/completed"',
  "[org.kinds.knowledge]",
  "nested = true",
  "[org.kinds.knowledge.status_folders]",
  'current = "knowledge"',
  "[org.kinds.capture]",
  'kind_value = "inbox"',
  "",
].join("\n");

/** @param {string} yaml @param {string} [body] */
const file = (yaml, body = "# Title\n") => `---\n${yaml}\ncreated: "2026-01-01"\n---\n${body}`;
const DONE = 'resolved: "2026-01-02"\nresolution: "https://example.org/pr/1"';

/** @param {any} body */
const errors = (body) =>
  body.findings
    .filter((/** @type {any} */ f) => f.level === "error")
    .map((/** @type {any} */ f) => `${f.path}:${f.line ?? ""} ${f.rule}`)
    .sort();

test("a house configured in house.toml lints its own layout: kind field, heading titles, nested and per-status folders", async (t) => {
  const house = makeHouse(t, {
    toml: COMPAT,
    files: {
      "tasks/a.md": file("type: task\nstatus: active", "# A\n\nSee [[skill://house]], [[agent://scout/x|scout]] and [[tasks/review/b]].\n"),
      "tasks/review/b.md": file("type: task\nstatus: review"),
      "tasks/completed/c.md": file(`type: task\nstatus: complete\n${DONE}`),
      "tasks/completed/implied.md": file(`type: task\n${DONE}`),
      "tasks/folded.md": file("type: task\nstatus: active\nsummary: >\n  folded\n  text\nmeta: {owner: ana, tags: [x,\n    y]}\nblocked-by: []"),
      "tasks/review/finished.md": file(`type: task\nstatus: complete\n${DONE}`),
      "tasks/waiting.md": file("type: task\nstatus: review"),
      "tasks/untitled.md": file("type: task\nstatus: active", "No heading here.\n```\n# not a heading inside code\n```\n"),
      "tasks/old-field.md": file("kind: task\nstatus: active"),
      "tasks/blocked.md": file('type: task\nstatus: blocked\nblocked-by: "a"'),
      "tasks/twice.md": file("type: task\nstatus: active"),
      "tasks/completed/twice.md": file(`type: task\nstatus: complete\n${DONE}`),
      "tasks/dangling.md": file("type: task\nstatus: active", "# D\n\n[[nowhere]]\n"),
      "knowledge/topic/deep/k.md": file("type: knowledge"),
      "knowledge/topic/bad.md": file("type: knowledge\nstatus: draft"),
      "inbox/captures/c1.md": file("type: inbox"),
      "inbox/captures/c2.md": file("type: capture"),
    },
  });
  const { code, body } = await cliJson(["lint"], house);
  assert.equal(code, 1);
  assert.equal(body.files, 17);
  assert.deepEqual(errors(body), [
    "inbox/captures/c2.md:2 kind",
    "knowledge/topic/bad.md:3 status",
    "tasks/blocked.md:4 list",
    "tasks/completed/twice.md: stem",
    "tasks/dangling.md:8 link",
    "tasks/old-field.md:1 required",
    "tasks/review/finished.md:3 placement",
    "tasks/untitled.md:1 required",
    "tasks/waiting.md:3 placement",
  ]);
  const message = (/** @type {string} */ path) => body.findings.find((/** @type {any} */ f) => f.path === path).message;
  assert.equal(message("tasks/review/finished.md"), "status complete belongs in tasks/completed/ but the file is in tasks/review/");
  assert.equal(message("tasks/old-field.md"), "missing required field type (kind task)");
  assert.equal(message("tasks/untitled.md"), "missing required field title and no level-1 heading (kind task)");
  assert.equal(message("inbox/captures/c2.md"), 'type "capture" is not in the schema (task, inbox, idea, decision, investigation, knowledge, reminder)');
});

test("the lifecycle writes the configured kind field and moves items between their status folders", async (t) => {
  const house = makeHouse(t, { toml: COMPAT });
  const created = await cliJson(["task", "new", "Ship it"], house);
  assert.equal(created.body.path, "tasks/ship-it.md");
  assert.match(read(house.root, "tasks/ship-it.md"), /^---\ntype: "task"\ntitle: "Ship it"\nstatus: "open"\n/);

  const review = await cliJson(["task", "set", "ship-it", "--status", "review"], house);
  assert.deepEqual([review.body.from, review.body.to], ["tasks/ship-it.md", "tasks/review/ship-it.md"]);
  const complete = await cliJson(["task", "set", "ship-it", "--status", "complete", "--resolution", "https://example.org/pr/2"], house);
  assert.equal(complete.body.to, "tasks/completed/ship-it.md");
  assert.equal((await cliJson(["lint"], house)).code, 0);
  const reopened = await cliJson(["task", "set", "ship-it", "--status", "active"], house);
  assert.equal(reopened.body.to, "tasks/ship-it.md");
  assert.equal((await cliJson(["lint"], house)).code, 0);

  // A nested item keeps its topic folder when its status moves it to another place.
  const nested = makeHouse(t, { toml: COMPAT, files: { "knowledge/topic/n.md": file("type: knowledge") } });
  const schema = loadOrgSchema(nested.root);
  const [item] = scanItems(nested.root, schema);
  const moved = transition(nested.root, schema, item, { status: "superseded", resolution: "https://example.org/x" });
  assert.equal(moved.to, "knowledge/resolved/topic/n.md");
  assert.ok(existsSync(join(nested.root, "knowledge", "resolved", "topic", "n.md")));
  assert.equal((await cliJson(["lint"], nested)).code, 0);
});

test("with no [org] settings the kind field is kind, titles are fields and subfolders are not read", async (t) => {
  const house = makeHouse(t, {
    files: {
      "tasks/typed.md": file("type: task\ntitle: T\nstatus: open"),
      "tasks/headed.md": file("kind: task\nstatus: open"),
      "knowledge/topic/k.md": file("kind: knowledge\ntitle: K\nstatus: bogus"),
      "tasks/linked.md": file("kind: task\ntitle: L\nstatus: open", "[[skill://house]]\n"),
      "tasks/again.md": file("kind: task\ntitle: A\nstatus: open"),
      "tasks/resolved/again.md": file(`kind: task\ntitle: A\nstatus: done\n${DONE}`),
    },
  });
  const { body } = await cliJson(["lint"], house);
  assert.equal(body.files, 5);
  assert.deepEqual(errors(body), ["tasks/again.md: stem", "tasks/headed.md:1 required", "tasks/typed.md:1 required"]);
});

/** @param {import("../u1/helpers.js").TestContext} t @param {string} toml @param {RegExp} message */
function refuses(t, toml, message) {
  const { root } = makeHouse(t, { toml });
  assert.throws(
    () => loadOrgSchema(root),
    (/** @type {unknown} */ error) => isLampstandError(error) && error.code === "E_SCHEMA" && message.test(error.message) && /house\.toml/.test(String(error.path)),
  );
}

test("[org] refuses status folders for unknown statuses or another kind's folders, and unknown title sources", (t) => {
  refuses(t, '[org.kinds.task.status_folders]\nwaiting = "tasks/waiting"\n', /org\.kinds\.task\.status_folders\.waiting is not a task status/);
  refuses(t, '[org.kinds.task.status_folders]\ndone = "inbox/ideas"\n', /org\.kinds\.task\.status_folders uses folder inbox\/ideas, which already belongs to kind idea/);
  refuses(t, '[org.kinds.task.status_folders]\ndone = "knowledge/resolved"\n', /already belongs to kind knowledge/);
  refuses(t, '[org]\ntitle_fallback = "filename"\n', /org\.title_fallback must be one of "heading"/);
  refuses(t, '[org.kinds.task]\nkind_value = "a task"\n', /org\.kinds\.task\.kind_value must match/);
});
