// @ts-check
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { checkGate, evaluateGate } from "../../core/lib/gate.js";
import { makeHouse } from "./helpers.js";

/** @param {import("../../core/lib/gate.js").GateResult} result */
const ids = (result) => result.owed.map((item) => item.id);

test("work outside the record folders owes a task record and a state update until the session touches them", (t) => {
  const { root } = makeHouse(t);
  const outside = join(root, "..", "elsewhere", "src", "main.js");
  const result = evaluateGate(root, [outside, join(root, "docs", "guide.md")], "remind");
  assert.deepEqual(ids(result), ["task", "state"]);
  assert.equal(result.block, null);
  assert.deepEqual(result.owed[0].because, [outside, "docs/guide.md"]);
  assert.deepEqual(result.owed[0].folder, "tasks/");

  assert.deepEqual(ids(evaluateGate(root, [outside, "tasks/resolved/x.md"], "remind")), ["state"]);
  assert.deepEqual(ids(evaluateGate(root, [outside, "tasks/x.md", join(root, "state", "current.md")], "remind")), []);
});

test("a session that only maintained the record owes nothing", (t) => {
  const { root } = makeHouse(t);
  assert.deepEqual(ids(evaluateGate(root, ["inbox/captures/a.md", "knowledge/k.md", "forge/sessions/s.md"], "block")), []);
  assert.deepEqual(evaluateGate(root, [], "block"), { mode: "block", owed: [], block: null });
});

test("a constitution change owes a compile unless .house/generated/ changed too", (t) => {
  const { root } = makeHouse(t);
  const changed = ["principles/lattice.md", "tasks/t.md", "state/current.md"];
  assert.deepEqual(ids(evaluateGate(root, changed, "remind")), ["projections"]);
  assert.deepEqual(ids(evaluateGate(root, [...changed, ".house/generated/kernel.md"], "remind")), []);
  // charter/record.md is not a compiler input: changing it alone owes no compile.
  assert.deepEqual(ids(evaluateGate(root, ["charter/record.md", "tasks/t.md", "state/current.md"], "remind")), []);
});

test("a session whose only act was a proposal or the record owes nothing", (t) => {
  const { root } = makeHouse(t);
  assert.deepEqual(ids(evaluateGate(root, ["proposals/provisions/test-with-every-bugfix.md"], "block")), []);
  assert.deepEqual(ids(evaluateGate(root, ["proposals/updates/curation.md", "charter/record.md"], "block")), []);
});

test("a constitutional file owes projections only, and nothing once .house/generated/ changed too; code still owes a task and state", (t) => {
  const { root } = makeHouse(t);
  for (const path of ["reflexes/read-first.md", "principles/own.md", "charter/core.md", "charter/provisions/x.md", "voice.md", "house.toml"]) {
    assert.deepEqual(ids(evaluateGate(root, [path], "remind")), ["projections"], path);
    assert.deepEqual(ids(evaluateGate(root, [path, ".house/generated/kernel.md"], "remind")), [], path);
  }
  assert.deepEqual(ids(evaluateGate(root, ["reflexes/read-first.md", "src/x.js"], "remind")), ["projections", "task", "state"]);
  assert.deepEqual(evaluateGate(root, ["reflexes/read-first.md", "src/x.js"], "remind").owed[1].because, ["src/x.js"]);
});

test("block mode turns what is owed into a reason; off owes nothing", (t) => {
  const { root } = makeHouse(t);
  const blocked = evaluateGate(root, ["src/x.js"], "block");
  assert.deepEqual(ids(blocked), ["task", "state"]);
  assert.match(String(blocked.block), /^the session owes the house before it ends: task \(.*\); state \(.*\)$/);
  assert.deepEqual(evaluateGate(root, ["src/x.js"], "off"), { mode: "off", owed: [], block: null });
});

test("checkGate reads house.toml [gate] mode, defaulting to remind", (t) => {
  assert.equal(checkGate(makeHouse(t).root, ["src/x.js"]).mode, "remind");
  const blocking = makeHouse(t, { toml: '[gate]\nmode = "block"\n' });
  assert.notEqual(checkGate(blocking.root, ["src/x.js"]).block, null);
  const off = makeHouse(t, { toml: '[gate]\nmode = "off"\n' });
  assert.deepEqual(checkGate(off.root, ["src/x.js"]).owed, []);
  const bad = makeHouse(t, { toml: '[gate]\nmode = "loud"\n' });
  assert.throws(() => checkGate(bad.root, []), /gate\.mode must be one of/);
});
