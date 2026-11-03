// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileHouse } from "../../core/lib/constitution/compile.js";
import { loadHouse } from "../../core/lib/constitution/house.js";
import { CURATION_RULES, KNOWN_GATES, runRules } from "../../core/lib/constitution/rules.js";
import { runCompile } from "../../core/lib/constitution/run.js";
import { plant, plantHouse, reflexFile, tempDir } from "./helpers.js";

// The rule list is exactly the objective checks dev/DESIGN.md section 7 names, and no more. It is small on purpose: a
// curation rule may only report what is wrong on the house's own evidence (a missing field, a size over its cap, a
// stale file). Anything that needs judgement about content belongs to the operator; growing this list into editorial
// checks would turn the agent's taste into errors, so adding a rule should be a deliberate change to this test.
test("the curation rules are exactly the objective set", () => {
  assert.deepEqual(
    CURATION_RULES.map((rule) => rule.id),
    ["occasion", "failure-mode", "reflex-revisable", "budget", "no-declared-totals", "generated-fresh", "provision-gates", "unconditional-surfaces"],
  );
});

const HASH = "0".repeat(64);

/** @param {string} root */
function findings(root) {
  const house = loadHouse(root);
  return runRules({ house, compiled: compileHouse(house), previous: null, onDisk: null, gates: KNOWN_GATES });
}

/** @param {ReturnType<typeof findings>} list */
function errors(list) {
  return list.filter((f) => f.level === "error").map((f) => [f.rule, f.path, f.message]);
}

test("a house planted from the templates with the lattice has no errors", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  assert.deepEqual(errors(findings(root)), []);
});

test("occasion: proposals, own principles, provisions and reflexes without one are errors; pack principles are not", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  plant(root, {
    "proposals/reflexes/later.md": '---\nscope: "behavioral"\nsummary: "s"\nproposed: "2026-11-02"\n---\n',
    "principles/mine.md": `---\norigin: "own"\nadopted: "2026-11-02"\nadopted-hash: "${HASH}"\n---\n### M : Mine\n\n*T.*\n\n- **f**: g\n\n*Vice:* v.\n`,
    "charter/provisions/quiet.md": `---\nadopted: "2026-11-02"\nadopted-hash: "${HASH}"\n---\n# Quiet\n`,
    "reflexes/bare.md": reflexFile("bare", "behavioral", { occasion: "" }),
  });
  assert.deepEqual(errors(findings(root)), [
    ["occasion", "proposals/reflexes/later.md", "proposed reflex later carries no occasion"],
    ["occasion", "principles/mine.md", "principle file mine carries no occasion"],
    ["occasion", "charter/provisions/quiet.md", "provision quiet carries no occasion"],
    ["occasion", "reflexes/bare.md", "reflex bare carries no occasion"],
  ]);
});

test("reflex-revisable: a reflex needs a falsification trigger and a revision step", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  plant(root, { "reflexes/stuck.md": reflexFile("stuck", "behavioral", { "falsified-when": "", revise: " " }) });
  assert.deepEqual(errors(findings(root)), [
    ["reflex-revisable", "reflexes/stuck.md", "reflex stuck carries no falsified-when trigger"],
    ["reflex-revisable", "reflexes/stuck.md", "reflex stuck carries no revise step"],
  ]);
});

test("no-declared-totals: a budget total in house.toml is an error", (t) => {
  const root = tempDir(t);
  plantHouse(root, { extra: "total = 40000\n" });
  assert.deepEqual(errors(findings(root)), [["no-declared-totals", "house.toml", "house.toml declares budget.total; totals are derived, never declared"]]);
});

test("provision-gates: a provision naming a gate that does not exist is an error; a real gate passes", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  const provision = (/** @type {string} */ gates) => `---\noccasion: "o"\nadopted: "2026-11-02"\nadopted-hash: "${HASH}"\ngates: ${gates}\n---\n# P\n`;
  plant(root, { "charter/provisions/real.md": provision('["budget"]'), "charter/provisions/ghost.md": provision('["budget", "nightly-audit"]') });
  assert.deepEqual(errors(findings(root)), [["provision-gates", "charter/provisions/ghost.md", "provision ghost names gate nightly-audit, which does not exist"]]);
});

test("unconditional-surfaces: more than five surfaces declared to load always is an error", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  const house = loadHouse(root);
  const compiled = compileHouse(house);
  /** @param {number} n */
  const withAlways = (n) => ({
    ...house,
    surfaces: Object.fromEntries(Array.from({ length: n }, (_, k) => [`s${k}`, { loads: "always" }]).concat([["extra", { loads: "on-demand" }]])),
  });
  const rule = /** @type {import("../../core/lib/constitution/rules.js").Rule} */ (CURATION_RULES.find((r) => r.id === "unconditional-surfaces"));
  const input = (/** @type {number} */ n) => ({ house: withAlways(n), compiled, previous: null, onDisk: null, gates: KNOWN_GATES });
  assert.deepEqual(rule.check(input(5)), []);
  assert.deepEqual(
    rule.check(input(6)).map((f) => f.message),
    ["6 surfaces load unconditionally (s0, s1, s2, s3, s4, s5); at most 5 may"],
  );
});

test("editorial matters are never errors: a kernel over its target is information", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  const run = runCompile(root);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(
    run.findings.map((f) => [f.rule, f.level]),
    [["budget", "info"]],
  );
  assert.match(run.findings[0].message, /^kernel is \d+ chars, over its target of 3500$/);
});
