// @ts-check
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "../../core/lib/frontmatter.js";
import { cli, cliJson, makeHouse, plant, read } from "./helpers.js";

const today = () => new Date().toISOString().slice(0, 10);

test("round trip: one of each kind, a decision resolved into resolved/ with links rewritten, lint clean", async (t) => {
  const house = makeHouse(t);
  /** @type {Record<string, string>} */
  const made = {};
  for (const [kind, args] of /** @type {const} */ ([
    ["task", ["task", "new", "Ship the parser", "--due", "2030-01-01"]],
    ["capture", ["capture", "Look at the flaky clock test"]],
    ["idea", ["inbox", "new", "idea", "Cache the index"]],
    ["decision", ["decide", "new", "Pick a storage format"]],
    ["investigation", ["inbox", "new", "investigation", "Why is CI slow"]],
    ["knowledge", ["knowledge", "new", "How releases work"]],
    ["reminder", ["remind", "new", "Renew the domain", "--due", "2030-06-01"]],
  ])) {
    const { code, body } = await cliJson([...args], house);
    assert.equal(code, 0, `${kind}: ${JSON.stringify(body)}`);
    assert.equal(body.kind, kind);
    const fm = /** @type {Record<string, unknown>} */ (parseFrontmatter(read(house.root, body.path), body.path).frontmatter);
    assert.equal(fm.kind, kind);
    assert.equal(fm.created, today());
    made[kind] = body.path;
  }
  assert.equal(made.decision, "inbox/decisions/pick-a-storage-format.md");
  assert.match(made.capture, /^inbox\/captures\/[0-9]{8}-[0-9]{4}-look-at-the-flaky-clock-test\.md$/);

  // A task links to the decision by path and by name; the knowledge note links by path with a heading and an alias.
  plant(house.root, {
    "tasks/follow-up.md": `---\nkind: task\ntitle: Follow up\nstatus: open\ncreated: "2026-01-01"\n---\nSee [[inbox/decisions/pick-a-storage-format]] and [[pick-a-storage-format]].\n`,
    "knowledge/storage.md": `---\nkind: knowledge\ntitle: Storage\nstatus: current\ncreated: "2026-01-01"\n---\nWhy: [[inbox/decisions/pick-a-storage-format.md#Decision|the call]]; not \`[[inbox/decisions/pick-a-storage-format]]\`.\n`,
  });
  assert.equal((await cli(["lint"], house)).code, 0);

  const resolved = await cliJson(["decide", "resolve", "pick-a-storage-format", "--resolution", "Landed in [[storage]]"], house);
  assert.equal(resolved.code, 0, JSON.stringify(resolved.body));
  const dest = "inbox/decisions/resolved/pick-a-storage-format.md";
  assert.equal(resolved.body.to, dest);
  assert.ok(!existsSync(join(house.root, "inbox", "decisions", "pick-a-storage-format.md")));
  const fm = /** @type {Record<string, unknown>} */ (parseFrontmatter(read(house.root, dest), dest).frontmatter);
  assert.deepEqual([fm.status, fm.resolved, fm.resolution], ["decided", today(), "Landed in [[storage]]"]);

  assert.equal(
    read(house.root, "tasks/follow-up.md").split("---\n")[2],
    "See [[inbox/decisions/resolved/pick-a-storage-format]] and [[pick-a-storage-format]].\n",
  );
  // The heading and alias survive, the .md suffix is kept, and the example inside code is left alone.
  assert.equal(
    read(house.root, "knowledge/storage.md").split("---\n")[2],
    "Why: [[inbox/decisions/resolved/pick-a-storage-format.md#Decision|the call]]; not `[[inbox/decisions/pick-a-storage-format]]`.\n",
  );
  const lint = await cliJson(["lint"], house);
  assert.equal(lint.code, 0, JSON.stringify(lint.body.findings));
  assert.equal(lint.body.errors, 0);
});

test("a terminal status needs a one-line resolution naming a link, and nothing changes without one", async (t) => {
  const house = makeHouse(t);
  await cli(["task", "new", "Write docs"], house);
  const before = read(house.root, "tasks/write-docs.md");
  for (const resolution of [undefined, "", "done it", "two\nlines [[x]]"]) {
    const args = ["task", "done", "write-docs", ...(resolution === undefined ? [] : ["--resolution", resolution])];
    const { code, body } = await cliJson(args, house);
    assert.equal(code, 64, String(resolution));
    assert.equal(body.error.code, "E_USAGE");
  }
  assert.equal(read(house.root, "tasks/write-docs.md"), before);
  const done = await cliJson(["task", "done", "write-docs", "--resolution", "https://example.org/pr/1"], house);
  assert.equal(done.code, 0);
  assert.equal(done.body.to, "tasks/resolved/write-docs.md");
});

test("reopening a resolved item clears resolved and resolution and moves it back", async (t) => {
  const house = makeHouse(t);
  await cli(["task", "new", "Fix login"], house);
  await cli(["task", "done", "fix-login", "--resolution", "[[fix-login]]"], house);
  const reopened = await cliJson(["task", "set", "fix-login", "--status", "active"], house);
  assert.equal(reopened.code, 0, JSON.stringify(reopened.body));
  assert.equal(reopened.body.to, "tasks/fix-login.md");
  const fm = /** @type {Record<string, unknown>} */ (parseFrontmatter(read(house.root, "tasks/fix-login.md"), "x").frontmatter);
  assert.equal(fm.status, "active");
  assert.equal(fm.resolved, undefined);
  assert.equal(fm.resolution, undefined);
  assert.equal((await cli(["lint"], house)).code, 0);
});

test("a name already taken in resolved/ gets a suffix, and links follow the new name", async (t) => {
  const house = makeHouse(t, {
    files: {
      "tasks/resolved/deploy.md": `---\nkind: task\ntitle: Deploy\nstatus: done\ncreated: "2026-01-01"\nresolved: "2026-01-02"\nresolution: "[[deploy-2]]"\n---\n`,
      "tasks/deploy-2.md": `---\nkind: task\ntitle: Deploy again\nstatus: open\ncreated: "2026-01-01"\n---\n`,
      "knowledge/note.md": `---\nkind: knowledge\ntitle: Note\nstatus: current\ncreated: "2026-01-01"\n---\n[[deploy-2]] and [[tasks/deploy-2]]\n`,
    },
  });
  // Place a file at the destination name so the move must pick another.
  plant(house.root, { "tasks/resolved/deploy-2.md": `---\nkind: task\ntitle: Old\nstatus: dropped\ncreated: "2026-01-01"\nresolved: "2026-01-02"\nresolution: "[[deploy]]"\n---\n` });
  const done = await cliJson(["task", "done", "tasks/deploy-2", "--resolution", "[[deploy]]"], house);
  assert.equal(done.code, 0, JSON.stringify(done.body));
  assert.equal(done.body.to, "tasks/resolved/deploy-2-2.md");
  // The name link meant the moved file only if no other file answers to it; here one does, so it is left.
  assert.equal(read(house.root, "knowledge/note.md").split("---\n")[2], "[[deploy-2]] and [[tasks/resolved/deploy-2-2]]\n");
});

test("set refuses a status outside the kind's schema", async (t) => {
  const house = makeHouse(t);
  await cli(["task", "new", "A"], house);
  const { code, body } = await cliJson(["task", "set", "a", "--status", "wip"], house);
  assert.equal(code, 64);
  assert.match(body.error.message, /"wip" is not a task status/);
});

test("lists show open items by default and resolved ones with --all", async (t) => {
  const house = makeHouse(t);
  await cli(["task", "new", "One"], house);
  await cli(["task", "new", "Two"], house);
  await cli(["task", "done", "two", "--resolution", "[[one]]"], house);
  assert.deepEqual((await cliJson(["task", "list"], house)).body.items.map((/** @type {any} */ item) => item.id), ["one"]);
  assert.deepEqual((await cliJson(["task", "list", "--all"], house)).body.items.map((/** @type {any} */ item) => item.id), ["one", "two"]);
  await cli(["remind", "new", "Late", "--due", "2000-01-01"], house);
  const reminders = await cliJson(["remind", "list"], house);
  assert.equal(reminders.body.items[0].overdue, true);
});

test("an item is named by its title, case-insensitively, or by text that slugifies to its stem; a near miss lists the closest stems", async (t) => {
  const house = makeHouse(t);
  for (const title of ["Query result shape", "Pick a storage format", "Pick a storage engine"]) {
    assert.equal((await cliJson(["decide", "new", title], house)).code, 0);
  }
  const byTitle = await cliJson(["decide", "resolve", "query RESULT shape", "--resolution", "Landed in [[x]]"], house);
  assert.equal(byTitle.code, 0, JSON.stringify(byTitle.body));
  assert.equal(byTitle.body.to, "inbox/decisions/resolved/query-result-shape.md");

  const bySlugified = await cliJson(["decide", "resolve", "Pick a storage format!", "--resolution", "Landed in [[x]]"], house);
  assert.equal(bySlugified.code, 0, JSON.stringify(bySlugified.body));
  assert.equal(bySlugified.body.to, "inbox/decisions/resolved/pick-a-storage-format.md");

  const miss = await cliJson(["decide", "resolve", "Pick a storage engin", "--resolution", "Landed in [[x]]"], house);
  assert.equal(miss.code, 64);
  assert.match(miss.body.error.message, /no decision named "Pick a storage engin"; did you mean pick-a-storage-engine[,?]/);
  const far = await cliJson(["decide", "resolve", "Something else entirely", "--resolution", "Landed in [[x]]"], house);
  assert.equal(far.body.error.message, 'no decision named "Something else entirely"');
});

test("a title that names two items is refused with both listed", async (t) => {
  const house = makeHouse(t);
  plant(house.root, {
    "tasks/a.md": '---\nkind: task\ntitle: Ship it\nstatus: open\ncreated: "2026-01-01"\n---\n',
    "tasks/b.md": '---\nkind: task\ntitle: ship IT\nstatus: open\ncreated: "2026-01-01"\n---\n',
  });
  const result = await cliJson(["task", "done", "Ship it", "--resolution", "Landed in [[x]]"], house);
  assert.equal(result.code, 64);
  assert.match(result.body.error.message, /names more than one task: tasks\/a\.md, tasks\/b\.md; give the path/);
  assert.equal((await cliJson(["task", "done", "a", "--resolution", "Landed in [[x]]"], house)).code, 0);
});
