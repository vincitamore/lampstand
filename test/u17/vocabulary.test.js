// @ts-check
import { localDate } from "../../core/lib/org/markdown.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isLampstandError } from "../../core/lib/errors.js";
import { loadOrgSchema } from "../../core/lib/org/schema.js";
import { cliJson, makeHouse, read } from "../u3/helpers.js";

/** A house that names its own fields: completed tasks and reminders record `completed:` and no resolution line. */
const NAMED = [
  "[org]",
  'not_items = ["**/README.md"]',
  "[org.kinds.task]",
  "resolution_required = false",
  "[org.kinds.task.fields]",
  'resolved = "completed"',
  "[org.kinds.reminder]",
  "resolution_required = false",
  "[org.kinds.reminder.fields]",
  'due = "remind-at"',
  'resolved = "completed"',
  "",
].join("\n");

/** @param {string} yaml @param {string} [body] */
const file = (yaml, body = "") => `---\n${yaml}\ncreated: "2026-01-01"\n---\n${body}`;

/** @param {any} body */
const errors = (body) =>
  body.findings
    .filter((/** @type {any} */ f) => f.level === "error")
    .map((/** @type {any} */ f) => `${f.path}:${f.line ?? ""} ${f.rule}`)
    .sort();

/** @param {any} body @param {string} path */
const messages = (body, path) => body.findings.filter((/** @type {any} */ f) => f.path === path).map((/** @type {any} */ f) => f.message);

test("a kind's field names and its waived resolution line are read by lint", async (t) => {
  const house = makeHouse(t, {
    toml: NAMED,
    files: {
      "reminders/call.md": file('kind: reminder\ntitle: Call\nstatus: open\nremind-at: "2026-01-02"'),
      "reminders/old-name.md": file('kind: reminder\ntitle: Old\nstatus: open\ndue: "2026-01-02"'),
      "reminders/resolved/done.md": file('kind: reminder\ntitle: Done\nstatus: done\nremind-at: "2026-01-02"\ncompleted: "2026-01-03"'),
      "tasks/resolved/shipped.md": file('kind: task\ntitle: Shipped\nstatus: done\ncompleted: "2026-01-03"'),
      "tasks/resolved/undated.md": file('kind: task\ntitle: Undated\nstatus: done\nresolved: "2026-01-03"'),
      "inbox/decisions/resolved/chosen.md": file('kind: decision\ntitle: Chosen\nstatus: decided\nresolved: "2026-01-03"'),
    },
  });
  const { body } = await cliJson(["lint"], house);
  assert.deepEqual(errors(body), [
    "inbox/decisions/resolved/chosen.md:1 required",
    "reminders/old-name.md:1 required",
    "tasks/resolved/undated.md:1 required",
  ]);
  assert.deepEqual(messages(body, "reminders/old-name.md"), ["missing required field remind-at (kind reminder)"]);
  assert.deepEqual(messages(body, "tasks/resolved/undated.md"), ["missing required field completed (status done is terminal)"]);
  assert.deepEqual(messages(body, "inbox/decisions/resolved/chosen.md"), ["missing required field resolution (status decided is terminal)"]);
  assert.deepEqual(messages(body, "reminders/call.md"), [`remind-at 2026-01-02, before today (${localDate()})`]);
});

test("create, list and transition write and read the house's field names", async (t) => {
  const house = makeHouse(t, { toml: NAMED });
  const created = await cliJson(["remind", "new", "Renew", "--due", "2099-05-01"], house);
  const text = read(house.root, created.body.path);
  assert.match(text, /^remind-at: "2099-05-01"$/m);
  assert.doesNotMatch(text, /^due:/m);
  const listed = await cliJson(["remind", "list"], house);
  assert.equal(listed.body.items[0].due, "2099-05-01");

  // A terminal status without --resolution is accepted where the kind waives it, and records the house's date field.
  const done = await cliJson(["remind", "done", "renew"], house);
  assert.equal(done.code, 0);
  const closed = read(house.root, done.body.to);
  assert.match(closed, /^completed: "\d{4}-\d{2}-\d{2}"$/m);
  assert.doesNotMatch(closed, /^(resolved|resolution):/m);
  assert.equal((await cliJson(["lint"], house)).code, 0);

  // A resolution given anyway is still checked and written.
  await cliJson(["task", "new", "Ship"], house);
  const refused = await cliJson(["task", "done", "ship", "--resolution", "somewhere"], house);
  assert.equal(refused.code, 64);
  const shipped = await cliJson(["task", "done", "ship", "--resolution", "https://example.org/pr/3"], house);
  assert.match(read(house.root, shipped.body.to), /^resolution: "https:\/\/example.org\/pr\/3"$/m);

  // Reopening clears the house's date field; a kind that still requires a resolution refuses to close without one.
  const reopened = await cliJson(["task", "set", "ship", "--status", "open"], house);
  assert.doesNotMatch(read(house.root, reopened.body.to), /^(completed|resolution):/m);
  await cliJson(["decide", "new", "Pick"], house);
  assert.equal((await cliJson(["decide", "resolve", "pick"], house)).code, 64);
});

test("files named not items are neither listed nor linted as items, but their links are checked", async (t) => {
  const house = makeHouse(t, {
    toml: NAMED,
    files: {
      "tasks/README.md": "---\nkind: index\n---\n# Tasks\n\nSee [[a]] and [[gone]].\n",
      "tasks/a.md": file("kind: task\ntitle: A\nstatus: open"),
      "knowledge/README.md": "no frontmatter at all, [[a]]\n",
    },
  });
  const { body } = await cliJson(["lint"], house);
  assert.equal(body.files, 1);
  assert.deepEqual(errors(body), ["tasks/README.md:6 link"]);
  assert.equal(body.info, 0);
  const listed = await cliJson(["task", "list"], house);
  assert.deepEqual(listed.body.items.map((/** @type {any} */ row) => row.path), ["tasks/a.md"]);
});

test("a file with no frontmatter in an org folder is information by default and an error when the house says so", async (t) => {
  const files = { "tasks/plain.md": "# Plain notes\n" };
  const quiet = await cliJson(["lint"], makeHouse(t, { files }));
  assert.equal(quiet.code, 0);
  assert.deepEqual(quiet.body.findings.map((/** @type {any} */ f) => `${f.level} ${f.rule}`), ["info not-an-item"]);
  const strict = await cliJson(["lint"], makeHouse(t, { toml: '[org]\nmissing_frontmatter = "error"\n', files }));
  assert.equal(strict.code, 1);
  assert.deepEqual(errors(strict.body), ["tasks/plain.md:1 not-an-item"]);
});

test("relative targets resolve from the linking file's folder, in wikilinks and Markdown links alike", async (t) => {
  const links = [
    "[[../knowledge/k]] [[./b]] [[./b.md]] [[../knowledge]] [[k]] [[knowledge/k]]",
    "[[./k]] [[../../outside]] [[../knowledge/missing]]",
    "[k](../knowledge/k.md) [b](./b.md#part \"title\") [s](<../knowledge/with space.md>) [e](../knowledge/with%20space.md)",
    "![img](./pic.png) [n](k.md) [f](../knowledge/) [self](#top) [web](https://example.org/x.md) [mail](mailto:a@example.invalid) [p](//host/x)",
    "[gone](./k.md) [up](../../../x.md) `[[../code/ignored]]` `[c](./ignored.md)`",
  ].join("\n");
  const house = makeHouse(t, {
    files: {
      "tasks/a.md": file("kind: task\ntitle: A\nstatus: open", `${links}\n`),
      "tasks/b.md": file("kind: task\ntitle: B\nstatus: open"),
      "tasks/pic.png": "png",
      "knowledge/k.md": file("kind: knowledge\ntitle: K\nstatus: current"),
      "knowledge/with space.md": file("kind: knowledge\ntitle: S\nstatus: current"),
    },
  });
  const { body } = await cliJson(["lint"], house);
  const found = body.findings.filter((/** @type {any} */ f) => f.path === "tasks/a.md").map((/** @type {any} */ f) => `${f.line} ${f.rule} ${f.message}`);
  assert.deepEqual(found, [
    "8 link [[./k]] resolves to no file in the house",
    "8 link [[../../outside]] resolves to no file in the house",
    "8 link [[../knowledge/missing]] resolves to no file in the house",
    "11 link (./k.md) resolves to no file in the house",
    "11 link (../../../x.md) resolves to no file in the house",
  ]);
});

test("moving a file rewrites relative links to it and its own relative links, in both syntaxes", async (t) => {
  const house = makeHouse(t, {
    files: {
      "tasks/a.md": file("kind: task\ntitle: A\nstatus: open", "[[../knowledge/k]] [k](../knowledge/k.md#x) [[./a]] [w](https://example.org/tasks/a.md)\n"),
      "knowledge/k.md": file("kind: knowledge\ntitle: K\nstatus: current", "[[../tasks/a]] [a](../tasks/a.md \"t\") [[./k]] [[tasks/a]]\n"),
      "tasks/b.md": file("kind: task\ntitle: B\nstatus: open", "[a](./a.md) [[a]]\n"),
    },
  });
  const done = await cliJson(["task", "done", "a", "--resolution", "https://example.org/pr/1"], house);
  assert.equal(done.body.to, "tasks/resolved/a.md");
  assert.ok(existsSync(join(house.root, "tasks", "resolved", "a.md")));
  assert.match(read(house.root, "tasks/resolved/a.md"), /\n\[\[\.\.\/\.\.\/knowledge\/k\]\] \[k\]\(\.\.\/\.\.\/knowledge\/k\.md#x\) \[\[\.\/a\]\] \[w\]\(https:\/\/example\.org\/tasks\/a\.md\)\n$/);
  assert.match(read(house.root, "knowledge/k.md"), /\n\[\[\.\.\/tasks\/resolved\/a\]\] \[a\]\(\.\.\/tasks\/resolved\/a\.md "t"\) \[\[\.\/k\]\] \[\[tasks\/resolved\/a\]\]\n$/);
  assert.match(read(house.root, "tasks/b.md"), /\n\[a\]\(\.\/resolved\/a\.md\) \[\[a\]\]\n$/);
  assert.equal((await cliJson(["lint"], house)).code, 0);

  // A Markdown destination keeps characters that would break it percent-encoded.
  const spaced = makeHouse(t, {
    files: { "knowledge/k.md": file("kind: knowledge\ntitle: K\nstatus: current", "[a](../tasks/a.md) [b](<../tasks/a.md>)\n"), "tasks/a.md": "x\n" },
  });
  assert.equal((await cliJson(["relink", "tasks/a.md", "tasks/a b.md"], spaced)).code, 0);
  assert.match(read(spaced.root, "knowledge/k.md"), /\n\[a\]\(\.\.\/tasks\/a%20b\.md\) \[b\]\(<\.\.\/tasks\/a b\.md>\)\n$/);
});

test("with no [org] settings, house field names, index notes and no-frontmatter files are read as before", async (t) => {
  const house = makeHouse(t, {
    files: {
      "reminders/r.md": file('kind: reminder\ntitle: R\nstatus: open\nremind-at: "2099-01-01"'),
      "tasks/resolved/t.md": file('kind: task\ntitle: T\nstatus: done\ncompleted: "2026-01-02"'),
      "tasks/README.md": "---\nkind: index\n---\n",
    },
  });
  const { body } = await cliJson(["lint"], house);
  assert.equal(body.files, 3);
  assert.deepEqual(errors(body), [
    "reminders/r.md:1 required",
    "tasks/README.md:1 required",
    "tasks/README.md:1 required",
    "tasks/README.md:1 required",
    "tasks/README.md:2 kind",
    "tasks/resolved/t.md:1 required",
    "tasks/resolved/t.md:1 required",
  ]);
});

/** @param {import("../u1/helpers.js").TestContext} t @param {string} toml @param {RegExp} message */
function refuses(t, toml, message) {
  const { root } = makeHouse(t, { toml });
  assert.throws(
    () => loadOrgSchema(root),
    (/** @type {unknown} */ error) => isLampstandError(error) && error.code === "E_SCHEMA" && message.test(error.message),
  );
}

test("[org] refuses field names that collide, unknown fields and bad settings", (t) => {
  refuses(t, '[org.kinds.task.fields]\ndue = "created"\n', /org\.kinds\.task\.fields\.due names "created", which is already the field for created/);
  refuses(t, '[org]\nkind_field = "type"\n[org.kinds.task.fields]\ntitle = "type"\n', /org\.kinds\.task\.fields\.title names "type", which is already the kind field/);
  refuses(t, '[org.kinds.task.fields]\nkind = "type"\n', /org\.kinds\.task\.fields\.kind is not a known key/);
  refuses(t, '[org]\nmissing_frontmatter = "warn"\n', /org\.missing_frontmatter must be one of "info", "error"/);
  refuses(t, '[org]\nnot_items = ["/tasks/README.md"]\n', /org\.not_items\[0\] must match/);
});
