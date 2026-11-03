// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { cli, cliJson, makeHouse } from "./helpers.js";

/** @param {Record<string, string>} fields @param {string} [body] */
const item = (fields, body = "") => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;
const TASK = { kind: "task", title: "T", status: "open", created: '"2026-01-01"' };

test("each objective error is reported with its path, rule and line; the clean file is not", async (t) => {
  const house = makeHouse(t, {
    files: {
      "tasks/clean.md": item(TASK, "Links to [[tasks/clean]] and [[clean]].\n"),
      "tasks/no-title.md": item({ kind: "task", status: "open", created: '"2026-01-01"' }),
      "tasks/bad-status.md": item({ ...TASK, status: "wip" }),
      "tasks/done-but-open.md": item({ ...TASK, status: "done", resolved: '"2026-01-02"', resolution: '"[[clean]]"' }),
      "tasks/resolved/open-but-resolved.md": item(TASK),
      "tasks/resolved/no-resolution.md": item({ ...TASK, status: "done" }),
      "tasks/dangling.md": item(TASK, "line one\nsee [[nowhere]] here\n"),
      "tasks/broken.md": "---\nkind: task\ntitle: [unclosed\n---\n",
      "tasks/wrong-kind.md": item({ ...TASK, kind: "decision" }),
      "tasks/README.md": "Tasks live here.\n",
    },
  });
  const { code, body } = await cliJson(["lint"], house);
  assert.equal(code, 1);
  const errors = body.findings
    .filter((/** @type {any} */ f) => f.level === "error")
    .map((/** @type {any} */ f) => `${f.path}:${f.line ?? ""} ${f.rule}`)
    .sort();
  assert.deepEqual(errors, [
    "tasks/bad-status.md:4 status",
    "tasks/broken.md:3 parse",
    "tasks/dangling.md:8 link",
    "tasks/done-but-open.md:4 placement",
    "tasks/no-title.md:1 required",
    "tasks/resolved/no-resolution.md:1 required",
    "tasks/resolved/no-resolution.md:1 required",
    "tasks/resolved/open-but-resolved.md:4 placement",
    "tasks/wrong-kind.md:2 kind",
  ]);
  // A file without frontmatter in an org folder may be a note someone meant to keep there: information only.
  const info = body.findings.filter((/** @type {any} */ f) => f.level === "info").map((/** @type {any} */ f) => `${f.path} ${f.rule}`);
  assert.deepEqual(info, ["tasks/README.md not-an-item"]);
});

test("text output names path and line", async (t) => {
  const house = makeHouse(t, { files: { "inbox/ideas/x.md": item({ kind: "idea", title: "X", status: "open", created: '"2026-01-01"' }, "[[gone]]\n") } });
  const result = await cli(["lint"], house);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^error inbox\/ideas\/x\.md:7: \[\[gone\]\] resolves to no file in the house \[link\]$/m);
});

test("a capture without status takes the kind's initial status; links to non-Markdown files and partial paths resolve", async (t) => {
  const house = makeHouse(t, {
    files: {
      "inbox/captures/20260101-0000-tick-failure.md": item({ kind: "capture", created: '"2026-01-01"' }, "[[diagram.png]] [[decisions/keep]] [[#Heading]]\n"),
      "assets/diagram.png": "png",
      "inbox/decisions/keep.md": item({ kind: "decision", title: "K", status: "open", created: '"2026-01-01"' }),
    },
  });
  const { code, body } = await cliJson(["lint"], house);
  assert.equal(code, 0, JSON.stringify(body.findings));
});

test("an overdue open reminder is information, never an error", async (t) => {
  const house = makeHouse(t, {
    files: { "reminders/r.md": item({ kind: "reminder", title: "R", status: "open", created: '"2000-01-01"', due: '"2000-01-02"' }) },
  });
  const { code, body } = await cliJson(["lint"], house);
  assert.equal(code, 0);
  assert.deepEqual(body.findings.map((/** @type {any} */ f) => `${f.level} ${f.rule}`), ["info overdue"]);
});
