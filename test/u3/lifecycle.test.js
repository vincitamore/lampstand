// @ts-check
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "../../core/lib/frontmatter.js";
import { createItem, scanItems, transition } from "../../core/lib/org/items.js";
import { localDate } from "../../core/lib/org/markdown.js";
import { loadOrgSchema } from "../../core/lib/org/schema.js";
import { cli, cliJson, makeHouse, plant, read } from "./helpers.js";

const today = () => localDate();

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

test("a status that means the work landed needs a link; dropped, withdrawn and abandoned take a plain reason", async (t) => {
  const house = makeHouse(t);
  for (const [args, status] of /** @type {const} */ ([
    [["inbox", "new", "idea", "Cache the index"], "dropped"],
    [["inbox", "new", "idea", "Cache the other index"], "adopted"],
    [["decide", "new", "Pick a store"], "withdrawn"],
    [["inbox", "new", "investigation", "Why is CI slow"], "abandoned"],
    [["decide", "new", "Pick a second store"], "superseded"],
  ])) {
    assert.equal((await cliJson([...args], house)).code, 0);
    const name = args.at(-1);
    const reason = await cliJson([args[0] === "decide" ? "decide" : "inbox", args[0] === "decide" ? "resolve" : "set", name ?? "", "--status", status, "--resolution", "no longer wanted"], house);
    const plain = ["dropped", "withdrawn", "abandoned"].includes(status);
    assert.equal(reason.code, plain ? 0 : 64, `${status}: ${JSON.stringify(reason.body)}`);
    if (!plain) assert.match(reason.body.error.message, /must name where the work landed with a \[\[wikilink\]\] or a URL \(only dropped, withdrawn, abandoned take a plain reason; decided takes the ruling in plain words\)/);
  }
  const missing = await cliJson(["inbox", "set", "cache-the-other-index", "--status", "dropped"], house);
  assert.equal(missing.code, 64);
  assert.match(missing.body.error.message, /dropped needs --resolution "<one line reason>"/);
  assert.equal((await cliJson(["inbox", "set", "cache-the-other-index", "--status", "adopted", "--resolution", "Landed in [[x]]"], house)).code, 0);
});

test("a long title is cut at the last whole word that fits, and a single long word is cut hard", async (t) => {
  const { slugify } = await import("../../core/lib/org/markdown.js");
  assert.equal(slugify("Magic sets is unsound under stratified negation unless negated predicates are adorned"), "magic-sets-is-unsound-under-stratified-negation-unless");
  assert.equal(slugify("aaaa bbbb cccc", 9), "aaaa-bbbb", "a hyphen exactly at the limit ends the cut");
  assert.equal(slugify("aaaa bbbb cccc", 8), "aaaa", "no hyphen at or before the limit but one: the whole words before it");
  assert.equal(slugify("aaaa bbbb", 9), "aaaa-bbbb", "a slug at the limit is whole");
  assert.equal(slugify("supercalifragilistic word", 10), "supercalif", "one word longer than the limit is cut hard");
  assert.equal(slugify("ab cd", 2), "ab");
  const house = makeHouse(t);
  const title = "A nested-loop join degrades a recursive Datalog rule from O(n) to O(n squared) in practice";
  const made = await cliJson(["knowledge", "new", title], house);
  assert.equal(made.body.path, "knowledge/a-nested-loop-join-degrades-a-recursive-datalog-rule-from-o.md");
});

test("a decision is resolved with the operator's ruling in plain words; a link still works and an empty ruling is refused", async (t) => {
  const house = makeHouse(t);
  assert.equal((await cliJson(["decide", "new", "Which plumber to call"], house)).code, 0);
  const ruled = await cliJson(["decide", "resolve", "which-plumber-to-call", "--resolution", "Go with Ace Plumbing."], house);
  assert.equal(ruled.code, 0, JSON.stringify(ruled.body));
  assert.equal(ruled.body.to, "inbox/decisions/resolved/which-plumber-to-call.md");
  const fm = /** @type {Record<string, unknown>} */ (parseFrontmatter(read(house.root, ruled.body.to), ruled.body.to).frontmatter);
  assert.deepEqual([fm.status, fm.resolution, fm.resolved], ["decided", "Go with Ace Plumbing.", today()]);
  assert.match(ruled.body.text, /-> inbox\/decisions\/resolved\/which-plumber-to-call\.md \(decided\)/, "the JSON carries the human text");

  assert.equal((await cliJson(["decide", "new", "Pick a store"], house)).code, 0);
  assert.equal((await cliJson(["inbox", "set", "pick-a-store", "--status", "decided", "--resolution", "Chosen in [[knowledge/stores]]"], house)).code, 0);
  assert.equal((await cliJson(["decide", "new", "Pick a colour"], house)).code, 0);
  const empty = await cliJson(["decide", "resolve", "pick-a-colour", "--resolution", " "], house);
  assert.equal(empty.code, 64);
  assert.match(empty.body.message, /decided needs --resolution "<the ruling, in one line>"/);
  const task = await cliJson(["task", "new", "Fix the sink"], house);
  const unlinked = await cliJson(["task", "done", "fix-the-sink", "--resolution", "fixed it"], house);
  assert.equal(unlinked.code, 64, "a task's done still names where the work landed");
  assert.equal(task.code, 0);
});

test("a duplicate title is saved under a free name and the result says so", async (t) => {
  const house = makeHouse(t);
  const first = await cliJson(["task", "new", "Buy stamps"], house);
  assert.equal(first.body.renamedFrom, null);
  assert.equal(first.body.text, "created tasks/buy-stamps.md");
  const second = await cliJson(["task", "new", "Buy stamps"], house);
  assert.equal(second.body.path, "tasks/buy-stamps-2.md");
  assert.equal(second.body.renamedFrom, "buy-stamps.md");
  assert.match(second.body.text, /^created tasks\/buy-stamps-2\.md \(a task named buy-stamps\.md already existed; saved as buy-stamps-2\.md\)$/);
});

test("an item that has already moved is not resolved a second time from a stale read", (t) => {
  const house = makeHouse(t);
  const schema = loadOrgSchema(house.root);
  const kind = /** @type {import("../../core/lib/org/schema.js").Kind} */ (schema.kinds.get("decision"));
  createItem(house.root, schema, kind, { title: "Reissue the hardcover" });
  const [stale] = scanItems(house.root, schema).filter((item) => item.kind.name === "decision");
  transition(house.root, schema, stale, { status: "decided", resolution: "Yes, in spring." });
  assert.throws(() => transition(house.root, schema, stale, { status: "decided", resolution: "Yes, in spring." }), /has already moved/);
  assert.ok(!existsSync(join(house.root, "inbox", "decisions", "resolved", "reissue-the-hardcover-2.md")), "no -2 copy is written");
  assert.ok(!existsSync(join(house.root, "inbox", "decisions", "reissue-the-hardcover.md")), "nothing is written back at the old path");
});

test("task list marks an open task past its due date overdue, by the local date, and lists by due date", async (t) => {
  const house = makeHouse(t);
  assert.equal((await cliJson(["task", "new", "Later", "--due", "2999-01-01"], house)).code, 0);
  assert.equal((await cliJson(["task", "new", "Undated"], house)).code, 0);
  assert.equal((await cliJson(["task", "new", "Galley proofs", "--due", "2001-11-01"], house)).code, 0);
  const listed = await cliJson(["task", "list"], house);
  assert.deepEqual(
    listed.body.items.map((/** @type {any} */ row) => [row.id, row.overdue]),
    [["galley-proofs", true], ["later", false], ["undated", false]],
  );
  assert.match((await cli(["task", "list"], house)).stdout, /due 2001-11-01 \(overdue\)/);
});
