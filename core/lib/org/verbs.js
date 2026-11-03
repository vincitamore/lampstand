// @ts-check
// The org verbs: tasks, the inbox, captures, decisions, knowledge, reminders, status, lint, relink and forge.
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fail } from "../errors.js";
import { readStdin } from "../io.js";
import { checkGate } from "../gate.js";
import { capLines, orient } from "../orient.js";
import { WORKSPACE_FLAGS, resolveHouse } from "../root.js";
import { appendLog, findSession, listSessions, newSession, readSession } from "./forge.js";
import { checkDate, createItem, findItem, fullPath, scanItems, statusOf, stemOfItem, titleOf, transition } from "./items.js";
import { moveAndRelink, relinkHouse } from "./links.js";
import { findingLine, lintOrg } from "./lint.js";
import { slugify, utcDate } from "./markdown.js";
import { fieldName, isTerminal, loadOrgSchema } from "./schema.js";

/** @typedef {import("../cli.js").Verb} Verb */
/** @typedef {import("../cli.js").VerbContext} VerbContext */
/** @typedef {import("../cli.js").VerbResult} VerbResult */
/** @typedef {import("./schema.js").OrgSchema} OrgSchema */
/** @typedef {import("./schema.js").Kind} Kind */
/** @typedef {import("./items.js").ItemFile} ItemFile */
/** @typedef {import("./items.js").Transition} Transition */

/** @param {VerbContext} context */
function houseRoot({ env, cwd, flags }) {
  const found = resolveHouse({ env, cwd, workspace: !flags["no-workspace"] });
  if (found.root === null) throw fail("E_NO_HOUSE", `no house resolved from ${resolve(cwd)}`);
  return found.root;
}

/** @param {VerbContext} context */
function open(context) {
  const root = houseRoot(context);
  return { root, schema: loadOrgSchema(root) };
}

/** @param {VerbContext} context @param {string} name @returns {string | undefined} */
function text(context, name) {
  const value = context.flags[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The text of `--body`; `-` reads it from standard input, so Markdown with backticks or quotes needs no shell quoting.
 * @param {VerbContext} context
 * @returns {string | undefined}
 */
function bodyText(context) {
  const value = text(context, "body");
  return value === "-" ? readStdin() : value;
}

/** @param {OrgSchema} schema @param {string} name */
function kindNamed(schema, name) {
  const kind = schema.kinds.get(name);
  if (!kind) throw fail("E_USAGE", `no kind ${JSON.stringify(name)} in the org schema (${[...schema.kinds.keys()].join(", ")})`);
  return kind;
}

/** Kinds whose folder is in the inbox. @param {OrgSchema} schema */
function inboxKinds(schema) {
  return [...schema.kinds.values()].filter((kind) => kind.folder.startsWith("inbox/"));
}

/** @param {string} root @param {OrgSchema} schema @param {Kind[]} kinds */
function itemsOf(root, schema, kinds) {
  const names = new Set(kinds.map((kind) => kind.name));
  return scanItems(root, schema).filter((item) => names.has(item.kind.name));
}

/** One list row; fields are read under the names the item's kind gives them. @param {ItemFile} item @param {OrgSchema} schema */
function itemData(item, schema) {
  const fm = item.frontmatter ?? {};
  /** @param {import("./schema.js").Field} field */
  const str = (field) => {
    const value = fm[fieldName(item.kind, field)];
    return typeof value === "string" ? value : undefined;
  };
  return {
    path: item.rel,
    id: stemOfItem(item),
    kind: item.kind.name,
    status: item.error ? null : statusOf(item) ?? null,
    title: titleOf(item, schema) ?? null,
    created: str("created") ?? null,
    due: str("due") ?? null,
    resolved: str("resolved") ?? null,
    resolution: str("resolution") ?? null,
    error: item.error ? item.error.message : null,
  };
}

/**
 * Lists items: open ones unless `all`, optionally one status.
 * @param {ItemFile[]} items
 * @param {{ schema: OrgSchema, all: boolean, status?: string, kindColumn?: boolean, sortByDue?: boolean, today?: string }} options
 * @returns {VerbResult}
 */
function listResult(items, options) {
  const isOpen = (/** @type {ItemFile} */ item, /** @type {string | null} */ status) => status === null || !isTerminal(item.kind, status);
  let pairs = items.map((item) => ({ item, row: itemData(item, options.schema) }));
  if (options.status !== undefined) pairs = pairs.filter(({ row }) => row.status === options.status);
  else if (!options.all) pairs = pairs.filter(({ item, row }) => isOpen(item, row.status));
  if (options.sortByDue) pairs.sort((a, b) => (a.row.due ?? "9999").localeCompare(b.row.due ?? "9999") || a.row.path.localeCompare(b.row.path));
  const rows = pairs.map(({ item, row }) => ({
    ...row,
    overdue: options.today !== undefined && row.due !== null && row.due < options.today && isOpen(item, row.status),
  }));
  const width = Math.max(0, ...rows.map((row) => row.id.length));
  const lines = rows.map((row) => {
    const parts = [row.id.padEnd(width)];
    if (options.kindColumn) parts.push(row.kind.padEnd(13));
    parts.push((row.status ?? (row.error ? "(unparsed)" : "(no status)")).padEnd(10));
    if (row.due) parts.push(`due ${row.due}${row.overdue ? " (overdue)" : ""}`);
    parts.push(row.title ?? "");
    return parts.join("  ").trimEnd();
  });
  return { data: { items: rows }, text: lines.length > 0 ? lines.join("\n") : "nothing to list" };
}

/** @param {Transition} done */
function transitionText(done) {
  const moved = done.from === done.to ? `${done.to}: status ${done.status}` : `${done.from} -> ${done.to} (${done.status})`;
  const links = done.relinked.reduce((sum, file) => sum + file.links, 0);
  return links === 0 ? moved : `${moved}; relinked ${links} link${links === 1 ? "" : "s"} in ${done.relinked.length} file${done.relinked.length === 1 ? "" : "s"}`;
}

/** @param {Transition} done */
function transitionData(done) {
  return { from: done.from, to: done.to, status: done.status, relinked: done.relinked };
}

/**
 * Finds the item named by the first argument among the kinds `select` picks, and moves it to its new status.
 * @param {VerbContext} context
 * @param {(schema: OrgSchema) => Kind[]} select
 * @param {string} what
 * @param {{ status?: string, fields?: Record<string, string> }} change
 * @returns {VerbResult}
 */
function runTransition(context, select, what, change) {
  const { root, schema } = open(context);
  const item = findItem(itemsOf(root, schema, select(schema)), context.args[0], what, schema);
  const done = transition(root, schema, item, { status: change.status ?? text(context, "status"), resolution: text(context, "resolution"), fields: change.fields });
  return { data: transitionData(done), text: transitionText(done) };
}

/**
 * @param {VerbContext} context
 * @param {string} kindName
 * @param {{ title?: string, body?: string, fields?: Record<string, string>, stem?: string }} [extra]
 * @returns {VerbResult}
 */
function runCreate(context, kindName, extra = {}) {
  const { root, schema } = open(context);
  const kind = kindNamed(schema, kindName);
  const rel = createItem(root, schema, kind, {
    title: extra.title ?? context.args[context.args.length - 1],
    body: extra.body ?? bodyText(context),
    fields: extra.fields,
    stem: extra.stem,
  });
  return { data: { path: rel, kind: kind.name }, text: `created ${rel}` };
}

const BODY = { body: { type: /** @type {const} */ ("string"), summary: "text to put under the title, or - to read it from stdin" } };
const RESOLUTION = {
  resolution: { type: /** @type {const} */ ("string"), summary: "one line naming where the work landed: a [[wikilink]] or a URL; for dropped, withdrawn or abandoned, a plain reason" },
};
const LIST_FLAGS = {
  all: { type: /** @type {const} */ ("boolean"), summary: "include resolved items" },
  status: { type: /** @type {const} */ ("string"), summary: "only items with this status" },
};

/** @type {Verb} */
export const taskNewVerb = {
  name: "task new",
  summary: "create a task in tasks/",
  args: { min: 1, max: 1, usage: "<title>" },
  flags: { ...BODY, due: { type: "string", summary: "due date, YYYY-MM-DD" }, ...WORKSPACE_FLAGS },
  run(context) {
    const due = text(context, "due");
    return runCreate(context, "task", { fields: due === undefined ? undefined : { due: checkDate(due, "due") } });
  },
};

/** @type {Verb} */
export const taskListVerb = {
  name: "task list",
  summary: "list open tasks (--all includes resolved ones)",
  flags: { ...LIST_FLAGS, ...WORKSPACE_FLAGS },
  run(context) {
    const { root, schema } = open(context);
    return listResult(itemsOf(root, schema, [kindNamed(schema, "task")]), { schema, all: context.flags.all === true, status: text(context, "status") });
  },
};

/** @type {Verb} */
export const taskSetVerb = {
  name: "task set",
  summary: "set a task's status, title or due date; a terminal status needs --resolution and moves it to tasks/resolved/",
  args: { min: 1, max: 1, usage: "<task>" },
  flags: {
    status: { type: "string", summary: "the new status" },
    ...RESOLUTION,
    title: { type: "string", summary: "a new title" },
    due: { type: "string", summary: "a new due date, YYYY-MM-DD" },
    ...WORKSPACE_FLAGS,
  },
  run(context) {
    /** @type {Record<string, string>} */
    const fields = {};
    const title = text(context, "title");
    const due = text(context, "due");
    if (title !== undefined) {
      if (title.trim() === "" || /[\r\n]/.test(title)) throw fail("E_USAGE", "a title is one non-empty line");
      fields.title = title.trim();
    }
    if (due !== undefined) fields.due = checkDate(due, "due");
    if (text(context, "status") === undefined && Object.keys(fields).length === 0 && text(context, "resolution") === undefined) {
      throw fail("E_USAGE", "lampstand task set needs --status, --title or --due");
    }
    return runTransition(context, (schema) => [kindNamed(schema, "task")], "task", { fields });
  },
};

/** @type {Verb} */
export const taskDoneVerb = {
  name: "task done",
  summary: "mark a task done with --resolution, moving it to tasks/resolved/",
  args: { min: 1, max: 1, usage: "<task>" },
  flags: { ...RESOLUTION, ...WORKSPACE_FLAGS },
  run(context) {
    return runTransition(context, (schema) => [kindNamed(schema, "task")], "task", { status: "done" });
  },
};

/** @type {Verb} */
export const inboxListVerb = {
  name: "inbox list",
  summary: "list open inbox items: captures, ideas, decisions, investigations",
  flags: { ...LIST_FLAGS, kind: { type: "string", summary: "only this kind" }, ...WORKSPACE_FLAGS },
  run(context) {
    const { root, schema } = open(context);
    const only = text(context, "kind");
    const kinds = only === undefined ? inboxKinds(schema) : [kindNamed(schema, only)];
    return listResult(itemsOf(root, schema, kinds), { schema, all: context.flags.all === true, status: text(context, "status"), kindColumn: true });
  },
};

/** @type {Verb} */
export const inboxNewVerb = {
  name: "inbox new",
  summary: "create an inbox item of a kind kept in inbox/ (idea, investigation, decision, capture)",
  args: { min: 2, max: 2, usage: "<kind> <title>" },
  flags: { ...BODY, ...WORKSPACE_FLAGS },
  run(context) {
    const { schema } = open(context);
    const kind = kindNamed(schema, context.args[0]);
    if (!inboxKinds(schema).includes(kind)) throw fail("E_USAGE", `${kind.name} items are not kept in inbox/ (${kind.folder}/)`);
    return runCreate(context, kind.name);
  },
};

/** @type {Verb} */
export const inboxSetVerb = {
  name: "inbox set",
  summary: "set an inbox item's status; a terminal status needs --resolution and moves it to its resolved/ folder",
  args: { min: 1, max: 1, usage: "<item>" },
  flags: { status: { type: "string", summary: "the new status" }, ...RESOLUTION, ...WORKSPACE_FLAGS },
  run(context) {
    if (text(context, "status") === undefined) throw fail("E_USAGE", "lampstand inbox set needs --status");
    return runTransition(context, inboxKinds, "inbox item", {});
  },
};

/** @type {Verb} */
export const captureVerb = {
  name: "capture",
  summary: "capture a thought into inbox/captures/ to sort later; the text may be - to read it from stdin",
  args: { min: 1, max: 1, usage: "\"<text>\" | -" },
  flags: WORKSPACE_FLAGS,
  run(context) {
    const body = (context.args[0] === "-" ? readStdin() : context.args[0]).trim();
    if (body === "") throw fail("E_USAGE", "nothing to capture");
    const first = body.split("\n", 1)[0].trim();
    const title = first.length > 80 ? `${first.slice(0, 77).trimEnd()}...` : first;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    return runCreate(context, "capture", { title, body: body === title ? "" : body, stem: `${stamp}-${slugify(title, 40) || "capture"}` });
  },
};

/** @type {Verb} */
export const decideNewVerb = {
  name: "decide new",
  summary: "open a decision in inbox/decisions/",
  args: { min: 1, max: 1, usage: "<title>" },
  flags: { ...BODY, ...WORKSPACE_FLAGS },
  run(context) {
    return runCreate(context, "decision");
  },
};

/** @type {Verb} */
export const decideResolveVerb = {
  name: "decide resolve",
  summary: "resolve a decision with --resolution (status decided unless --status), moving it to inbox/decisions/resolved/",
  args: { min: 1, max: 1, usage: "<decision>" },
  flags: { ...RESOLUTION, status: { type: "string", summary: "the terminal status (default decided)" }, ...WORKSPACE_FLAGS },
  run(context) {
    const status = text(context, "status") ?? "decided";
    /** @param {OrgSchema} schema */
    const select = (schema) => {
      const kind = kindNamed(schema, "decision");
      if (!isTerminal(kind, status)) throw fail("E_USAGE", `decide resolve takes a terminal status (${kind.terminal.join(", ")}), not ${JSON.stringify(status)}`);
      return [kind];
    };
    return runTransition(context, select, "decision", { status });
  },
};

/** @type {Verb} */
export const knowledgeNewVerb = {
  name: "knowledge new",
  summary: "write a knowledge note in knowledge/",
  args: { min: 1, max: 1, usage: "<title>" },
  flags: { ...BODY, ...WORKSPACE_FLAGS },
  run(context) {
    return runCreate(context, "knowledge");
  },
};

/** @type {Verb} */
export const knowledgeListVerb = {
  name: "knowledge list",
  summary: "list current knowledge notes (--all includes superseded ones)",
  flags: { ...LIST_FLAGS, ...WORKSPACE_FLAGS },
  run(context) {
    const { root, schema } = open(context);
    return listResult(itemsOf(root, schema, [kindNamed(schema, "knowledge")]), { schema, all: context.flags.all === true, status: text(context, "status") });
  },
};

/** @type {Verb} */
export const remindNewVerb = {
  name: "remind new",
  summary: "create a reminder in reminders/ with --due YYYY-MM-DD",
  args: { min: 1, max: 1, usage: "<title>" },
  flags: { due: { type: "string", summary: "due date, YYYY-MM-DD (required)" }, ...BODY, ...WORKSPACE_FLAGS },
  run(context) {
    const due = text(context, "due");
    if (due === undefined) throw fail("E_USAGE", "lampstand remind new needs --due YYYY-MM-DD");
    return runCreate(context, "reminder", { fields: { due: checkDate(due, "due") } });
  },
};

/** @type {Verb} */
export const remindListVerb = {
  name: "remind list",
  summary: "list open reminders by due date, marking overdue ones",
  flags: { ...LIST_FLAGS, ...WORKSPACE_FLAGS },
  run(context) {
    const { root, schema } = open(context);
    const items = itemsOf(root, schema, [kindNamed(schema, "reminder")]);
    return listResult(items, { schema, all: context.flags.all === true, status: text(context, "status"), sortByDue: true, today: utcDate() });
  },
};

/** @type {Verb} */
export const remindDoneVerb = {
  name: "remind done",
  summary: "mark a reminder done with --resolution, moving it to reminders/resolved/",
  args: { min: 1, max: 1, usage: "<reminder>" },
  flags: { ...RESOLUTION, ...WORKSPACE_FLAGS },
  run(context) {
    return runTransition(context, (schema) => [kindNamed(schema, "reminder")], "reminder", { status: "done" });
  },
};

/** @type {Verb} */
export const statusVerb = {
  name: "status",
  summary: "org counts per kind and status, then only the problems (--orient: held to the orientation budget)",
  flags: { orient: { type: "boolean", summary: "the dynamic orientation text a session starts with, within its budget" }, ...WORKSPACE_FLAGS },
  run(context) {
    const root = houseRoot(context);
    const found = orient(root, { env: context.env });
    if (context.flags.orient) {
      const capped = capLines(found.lines, found.cap);
      return {
        data: { house: root, counts: found.counts, problems: found.problems, text: capped.text, omitted: capped.omitted, cap: found.cap, profile: found.profile },
        text: capped.text,
      };
    }
    return { data: { house: root, counts: found.counts, problems: found.problems }, text: found.lines.join("\n") };
  },
};

/** @type {Verb} */
export const lintVerb = {
  name: "lint",
  summary: "check org items objectively: parse, required fields, kind and status, resolved/ placement, dangling links",
  flags: WORKSPACE_FLAGS,
  run(context) {
    const { root, schema } = open(context);
    const { findings, items } = lintOrg(root, schema);
    const errors = findings.filter((finding) => finding.level === "error").length;
    const info = findings.length - errors;
    const summary = `${errors} error${errors === 1 ? "" : "s"}, ${info} info in ${items.length} org file${items.length === 1 ? "" : "s"}`;
    return {
      ok: errors === 0,
      exit: errors === 0 ? 0 : 1,
      data: { house: root, errors, info, files: items.length, findings },
      text: [...findings.map(findingLine), summary].join("\n"),
    };
  },
};

/**
 * A path the user named, as house-relative with `/`; refused when outside the house or inside .git.
 * @param {string} root
 * @param {string} cwd
 * @param {string} path
 */
function houseRel(root, cwd, path) {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(root, absolute).replace(/\\/g, "/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw fail("E_USAGE", `${path} is not inside the house ${root}`);
  if (rel.split("/").some((segment) => segment.toLowerCase() === ".git")) throw fail("E_USAGE", `${path} is inside .git`);
  return rel;
}

/** @type {Verb} */
export const relinkVerb = {
  name: "relink",
  summary: "move a house file (or record that it moved) and rewrite every link to it across the house",
  args: { min: 2, max: 2, usage: "<old> <new>" },
  flags: WORKSPACE_FLAGS,
  run(context) {
    const root = houseRoot(context);
    const from = houseRel(root, context.cwd, context.args[0]);
    const to = houseRel(root, context.cwd, context.args[1]);
    if (/[\[\]|#^]/.test(to)) throw fail("E_USAGE", `${to} cannot be a wikilink target: it holds [, ], |, # or ^`);
    const fromExists = existsSync(fullPath(root, from));
    const toExists = existsSync(fullPath(root, to));
    let relinked;
    if (fromExists && !toExists) relinked = moveAndRelink(root, from, to);
    else if (!fromExists && toExists) relinked = relinkHouse(root, from, to);
    else if (fromExists) throw fail("E_USAGE", `both ${from} and ${to} exist; relink needs the file at exactly one of them`);
    else throw fail("E_USAGE", `neither ${from} nor ${to} exists`);
    const links = relinked.reduce((sum, file) => sum + file.links, 0);
    return {
      data: { from, to, moved: fromExists, relinked },
      text: `${fromExists ? `moved ${from} -> ${to}; ` : ""}relinked ${links} link${links === 1 ? "" : "s"} in ${relinked.length} file${relinked.length === 1 ? "" : "s"}${relinked.map((file) => `\n  ${file.path} (${file.links})`).join("")}`,
    };
  },
};

/** @type {Verb} */
export const forgeNewVerb = {
  name: "forge new",
  summary: "start a pipeline manifest in forge/sessions/ with an empty execution log",
  args: { min: 1, max: 1, usage: "<title>" },
  flags: { stages: { type: "string", summary: "comma-separated pipeline stages, in order" }, ...BODY, ...WORKSPACE_FLAGS },
  run(context) {
    const root = houseRoot(context);
    const raw = text(context, "stages");
    const stages = raw === undefined ? [] : raw.split(",").map((stage) => stage.trim()).filter((stage) => stage !== "");
    const rel = newSession(root, { title: context.args[0], stages, body: bodyText(context) });
    return { data: { path: rel, stages }, text: `created ${rel}` };
  },
};

/** @type {Verb} */
export const forgeLogVerb = {
  name: "forge log",
  summary: "append `- <UTC time> | <entry>` to a session's execution log; the time is written by lampstand, never given",
  args: { min: 2, max: 2, usage: "<session> \"<entry>\"" },
  flags: WORKSPACE_FLAGS,
  run(context) {
    const root = houseRoot(context);
    const rel = findSession(root, context.args[0]);
    const line = appendLog(root, rel, context.args[1]);
    return { data: { path: rel, line }, text: `${rel}: ${line}` };
  },
};

/** @type {Verb} */
export const forgeStatusVerb = {
  name: "forge status",
  summary: "list forge sessions, or show one session's stages and latest log entries",
  args: { min: 0, max: 1, usage: "[<session>]" },
  flags: WORKSPACE_FLAGS,
  run(context) {
    const root = houseRoot(context);
    if (context.args.length === 1) {
      const session = readSession(root, findSession(root, context.args[0]));
      const recent = session.entries.slice(-10);
      const lines = [
        `${session.path}: ${session.title || "(untitled)"}`,
        `status ${session.status || "(none)"}; created ${session.created || "(unknown)"}; ${session.entries.length} log entr${session.entries.length === 1 ? "y" : "ies"}`,
        `stages: ${session.stages.length > 0 ? session.stages.join(" -> ") : "none declared"}`,
        ...(session.error ? [`frontmatter: ${session.error}`] : []),
        ...recent.map((entry) => `- ${entry.at} | ${entry.entry}`),
      ];
      return { data: { session }, text: lines.join("\n") };
    }
    const sessions = listSessions(root).map((rel) => readSession(root, rel));
    const lines = sessions.map((session) => {
      const last = session.entries.at(-1);
      return `${session.path}  ${session.status || "(none)"}  ${session.entries.length} entries${last ? `, last ${last.at}` : ""}  ${session.title}`;
    });
    return { data: { sessions }, text: lines.length > 0 ? lines.join("\n") : "no forge sessions" };
  },
};

/** The org verbs, registered by core/bin/lampstand.js. @type {Verb[]} */
/** @type {Verb} */
export const gateVerb = {
  name: "gate",
  summary: "what the session owes the house before it ends, given the paths it changed (exit 1 when the gate blocks)",
  args: { min: 0, max: 100000, usage: "[<changed path>...]" },
  flags: {
    ...WORKSPACE_FLAGS,
    since: { type: "string", summary: "the commit the session started at (empty before the first commit): add what git reports changed since" },
    "since-time": { type: "string", summary: "the session's start in epoch milliseconds: untracked files modified after it count" },
  },
  run(context) {
    const root = houseRoot(context);
    const since = context.flags.since;
    const sinceTime = context.flags["since-time"];
    if ((since === undefined) !== (sinceTime === undefined)) throw fail("E_USAGE", "--since and --since-time go together");
    if (sinceTime !== undefined && !/^\d+$/.test(String(sinceTime))) throw fail("E_USAGE", "--since-time takes epoch milliseconds");
    const session = since === undefined ? undefined : { since: since === true ? "" : String(since), sinceMs: Number(sinceTime) };
    const result = checkGate(root, context.args, session);
    const lines = result.owed.map((item) => `  ${item.id}: ${item.owed}`);
    return {
      exit: result.block ? 1 : 0,
      data: { mode: result.mode, owed: result.owed, block: result.block, source: result.source },
      text: result.owed.length === 0 ? `gate (${result.mode}): nothing owed` : `gate (${result.mode}): owed\n${lines.join("\n")}${result.block ? "\nblock: the session cannot end until these are done" : ""}`,
    };
  },
};

export const verbs = [
  taskNewVerb,
  taskListVerb,
  taskSetVerb,
  taskDoneVerb,
  inboxListVerb,
  inboxNewVerb,
  inboxSetVerb,
  captureVerb,
  decideNewVerb,
  decideResolveVerb,
  knowledgeNewVerb,
  knowledgeListVerb,
  remindNewVerb,
  remindListVerb,
  remindDoneVerb,
  statusVerb,
  lintVerb,
  relinkVerb,
  forgeNewVerb,
  forgeLogVerb,
  forgeStatusVerb,
  gateVerb,
];
