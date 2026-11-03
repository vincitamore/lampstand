// @ts-check
// The gate sees what a session changed through git, not only through the host's edit-tool events: a file written by
// a lampstand verb or the shell counts, an untracked file older than the session does not, and a session that
// changed nothing owes nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkGate, sessionChanges } from "../../core/lib/gate.js";

/** @param {string} root @param {string[]} args */
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** @param {{ after(fn: () => void): void }} t */
function house(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-gate-")));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  writeFileSync(join(root, "house.toml"), '[house]\nschema = 1\nid = "0b9a1c2e-4f5d-4e6a-8b7c-9d0e1f2a3b4c"\nname = "g"\n[gate]\nmode = "block"\n');
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.js"), "export {};\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  return root;
}

test("work done without an edit-tool event is seen: a tracked change and a new file count, an older untracked file does not", (t) => {
  const root = house(t);
  const old = join(root, "notes-from-before.txt");
  writeFileSync(old, "x\n");
  const past = new Date(Date.now() - 60_000);
  utimesSync(old, past, past);
  const session = { since: git(root, "rev-parse", "HEAD"), sinceMs: Date.now() - 1_000 };

  writeFileSync(join(root, "src", "app.js"), "export const changed = true;\n");
  writeFileSync(join(root, "src", "new.js"), "export {};\n");

  const changed = sessionChanges(root, session);
  assert.deepEqual([...(changed ?? [])].sort(), ["src/app.js", "src/new.js"]);

  const gate = checkGate(root, [], session);
  assert.equal(gate.source, "observed+git");
  assert.deepEqual(gate.owed.map((item) => item.id).sort(), ["state", "task"]);
  assert.notEqual(gate.block, null);
});

test("a session that recorded its work through the record folders is no longer blocked", (t) => {
  const root = house(t);
  const session = { since: git(root, "rev-parse", "HEAD"), sinceMs: Date.now() - 1_000 };
  writeFileSync(join(root, "src", "app.js"), "export const changed = true;\n");
  mkdirSync(join(root, "tasks"));
  writeFileSync(join(root, "tasks", "ship-it.md"), "---\nkind: task\n---\n");
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "current.md"), "Shipping.\n");
  const gate = checkGate(root, [], session);
  assert.deepEqual(gate.owed, []);
  assert.equal(gate.block, null);
});

test("a session that changed nothing owes nothing, and a house with no commit yet diffs against the empty tree", (t) => {
  const root = house(t);
  const session = { since: git(root, "rev-parse", "HEAD"), sinceMs: Date.now() };
  assert.deepEqual(sessionChanges(root, session), []);
  assert.deepEqual(checkGate(root, [], session).owed, []);

  const fresh = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-gate-")));
  t.after(() => rmSync(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(fresh, "init", "-q");
  writeFileSync(join(fresh, "a.txt"), "a\n");
  git(fresh, "add", "a.txt");
  assert.deepEqual(sessionChanges(fresh, { since: "", sinceMs: Date.now() + 60_000 }), ["a.txt"]);
});

test("outside a git repository the gate falls back to the paths it observed", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-gate-")));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  writeFileSync(join(root, "house.toml"), '[house]\nschema = 1\nid = "0b9a1c2e-4f5d-4e6a-8b7c-9d0e1f2a3b4c"\nname = "g"\n');
  assert.equal(sessionChanges(root, { since: "", sinceMs: 0 }), null);
  assert.equal(checkGate(root, [join(root, "x.js")], { since: "", sinceMs: 0 }).source, "observed");
});
