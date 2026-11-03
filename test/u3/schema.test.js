// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLampstandError } from "../../core/lib/errors.js";
import { loadOrgSchema } from "../../core/lib/org/schema.js";
import { cliJson, makeHouse, plant } from "./helpers.js";

// Every house's files are written against these defaults, and a house may only add to them. Changing a default kind,
// status or folder strands existing items (lint would call them errors, lifecycle would move them elsewhere), so a
// change here must be a deliberate migration, not an edit that slips through.
test("the default kinds, statuses and folders are exactly these", (t) => {
  const { root } = makeHouse(t);
  const schema = loadOrgSchema(root);
  const view = Object.fromEntries(
    [...schema.kinds.values()].map((kind) => [kind.name, { folders: kind.folders, statuses: kind.statuses, terminal: kind.terminal, initial: kind.initial, required: kind.required }]),
  );
  const std = ["kind", "title", "status", "created"];
  assert.deepStrictEqual(view, {
    task: { folders: ["tasks"], statuses: ["open", "active", "blocked", "done", "dropped"], terminal: ["done", "dropped"], initial: "open", required: std },
    capture: { folders: ["inbox/captures"], statuses: ["open", "filed", "dropped"], terminal: ["filed", "dropped"], initial: "open", required: ["kind", "created"] },
    idea: { folders: ["inbox/ideas"], statuses: ["open", "adopted", "dropped"], terminal: ["adopted", "dropped"], initial: "open", required: std },
    decision: { folders: ["inbox/decisions"], statuses: ["open", "decided", "superseded", "withdrawn"], terminal: ["decided", "superseded", "withdrawn"], initial: "open", required: std },
    investigation: { folders: ["inbox/investigations"], statuses: ["open", "active", "concluded", "abandoned"], terminal: ["concluded", "abandoned"], initial: "open", required: std },
    knowledge: { folders: ["knowledge"], statuses: ["current", "superseded"], terminal: ["superseded"], initial: "current", required: std },
    reminder: { folders: ["reminders"], statuses: ["open", "done", "dropped"], terminal: ["done", "dropped"], initial: "open", required: [...std, "due"] },
  });
  assert.equal(schema.resolvedFolder, "resolved");
  assert.deepStrictEqual(schema.resolvedFields, ["resolved", "resolution"]);
});

test("house.toml [org] adds kinds, statuses and folders on top of the defaults", async (t) => {
  const house = makeHouse(t, {
    toml: [
      "[org.kinds.task]",
      'statuses = ["waiting", "handed-off"]',
      'terminal = ["handed-off"]',
      'folders = ["projects/alpha/tasks"]',
      "[org.kinds.meeting]",
      'folder = "meetings"',
      'statuses = ["planned", "held", "cancelled"]',
      'terminal = ["held", "cancelled"]',
      "",
    ].join("\n"),
  });
  const schema = loadOrgSchema(house.root);
  const task = /** @type {import("../../core/lib/org/schema.js").Kind} */ (schema.kinds.get("task"));
  assert.deepStrictEqual(task.statuses, ["open", "active", "blocked", "done", "dropped", "waiting", "handed-off"]);
  assert.deepStrictEqual(task.terminal, ["done", "dropped", "handed-off"]);
  assert.deepStrictEqual(task.folders, ["tasks", "projects/alpha/tasks"]);
  const meeting = /** @type {import("../../core/lib/org/schema.js").Kind} */ (schema.kinds.get("meeting"));
  assert.deepStrictEqual([meeting.folder, meeting.initial, meeting.required], ["meetings", "planned", ["kind", "title", "status", "created"]]);

  // An item of the added kind lints, and resolving into the extra folder's own resolved/ is a placement the lint accepts.
  plant(house.root, {
    "meetings/kickoff.md": '---\nkind: meeting\ntitle: Kickoff\nstatus: planned\ncreated: "2026-01-01"\n---\n',
    "projects/alpha/tasks/resolved/a.md": '---\nkind: task\ntitle: A\nstatus: handed-off\ncreated: "2026-01-01"\nresolved: "2026-01-02"\nresolution: "[[kickoff]]"\n---\n',
  });
  const lint = await cliJson(["lint"], house);
  assert.equal(lint.code, 0, JSON.stringify(lint.body.findings));
  assert.equal(lint.body.files, 2);
});

/** @param {import("../u1/helpers.js").TestContext} t @param {string} toml @param {RegExp} message */
function refuses(t, toml, message) {
  const { root } = makeHouse(t, { toml });
  assert.throws(
    () => loadOrgSchema(root),
    (/** @type {unknown} */ error) => isLampstandError(error) && error.code === "E_SCHEMA" && message.test(error.message) && /house\.toml/.test(String(error.path)),
  );
}

test("[org] never removes or redefines a default, and refuses inconsistent kinds by name", (t) => {
  refuses(t, '[org.kinds.task]\nfolder = "todo"\n', /org\.kinds\.task\.folder cannot be set for the default kind task/);
  refuses(t, '[org.kinds.task]\nrequired = ["owner"]\n', /org\.kinds\.task\.required cannot be set/);
  refuses(t, '[org.kinds.task]\nterminal = ["blocked"]\n', /a default status cannot be made terminal/);
  refuses(t, '[org.kinds.meeting]\nfolder = "meetings"\nstatuses = ["planned"]\n', /org\.kinds\.meeting is a new kind and needs terminal/);
  refuses(t, '[org.kinds.meeting]\nfolder = "meetings"\nstatuses = ["planned"]\nterminal = ["held"]\n', /names "held", which is not in statuses/);
  refuses(t, '[org.kinds.meeting]\nfolder = "tasks"\nstatuses = ["a", "b"]\nterminal = ["b"]\n', /already belongs to kind task/);
  refuses(t, '[org.kinds.meeting]\nfolder = "tasks/resolved"\nstatuses = ["a", "b"]\nterminal = ["b"]\n', /is the resolved folder of kind task/);
  refuses(t, '[org.kinds.meeting]\nfolder = "../outside"\nstatuses = ["a"]\nterminal = []\n', /org\.kinds\.meeting\.folder must match/);
  refuses(t, "[org]\nsurprise = 1\n", /org\.surprise is not a known key/);
});
