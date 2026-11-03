// @ts-check
// Each case runs the gate against a copy of this tree's CLI, templates and schema with a planted lattice pack (and,
// for the floor, a planted AGENTS.md template), so the cases do not depend on the size of the shipped lattice.
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gate, plant, REPO, tempDir } from "./helpers.js";

/** @param {import("./helpers.js").TestContext} t @param {Record<string, string>} files */
function tree(t, files) {
  const root = join(tempDir(t), "lampstand");
  for (const part of ["core", "templates", "packs", "schema", "package.json"]) cpSync(join(REPO, part), join(root, part), { recursive: true });
  plant(root, files);
  return root;
}

/** A lattice of `count` principles whose thesis is `thesis` characters long. @param {number} count @param {number} thesis */
function lattice(count, thesis) {
  const principles = [];
  for (let k = 1; k <= count; k++) {
    principles.push(
      `### P${k} : Principle ${k}\n\n*${"t".repeat(thesis - 1)}.*\n\n- **facet**: a facet.\n\n*Failure mode:* **drift** when it is ignored.\n`,
    );
  }
  return `## A small lattice\n\n${principles.join("\n")}`;
}

test("context-budget passes a house whose kernel fits and whose AGENTS.md is under the Hermes floor", (t) => {
  const root = tree(t, { "packs/lattice/LATTICE.md": lattice(3, 80) });
  const run = gate("context-budget.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 0, run.out);
  assert.match(run.stdout, /house planted with the lattice and a \d+-character purpose/);
  assert.match(run.stdout, /^ {2}kernel +\d+ chars/m);
  assert.match(run.stdout, /^ {2}AGENTS\.md +\d+ chars {2}\(floor 20000\)$/m);
});

test("context-budget fails when the lattice's kernel lines alone are over its hard cap", (t) => {
  // init refuses any answers whose kernel overflows, so the only overflow a first run can meet is a lattice whose
  // principle lines leave no room even for an empty purpose.
  const root = tree(t, { "packs/lattice/LATTICE.md": lattice(12, 400) });
  const run = gate("context-budget.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 1, run.out);
  assert.match(run.stdout, /^context-budget: kernel is \d+ chars with an empty purpose and no ask-first lines \(with 79 of Hermes section framing\), over its hard cap of 4000; init refuses every answer$/m);
});

test("context-budget fails when AGENTS.md is over the Hermes context-file floor", (t) => {
  const template = readFileSync(join(REPO, "templates", "root", "AGENTS.md"), "utf8");
  const manual = `${"Notes the operator wrote for the agents of this house.\n".repeat(400)}\n`;
  const root = tree(t, {
    "packs/lattice/LATTICE.md": lattice(3, 80),
    "templates/root/AGENTS.md": template.replace("<!-- house:begin -->", `${manual}<!-- house:begin -->`),
  });
  const run = gate("context-budget.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 1, run.out);
  assert.match(run.stdout, /^context-budget: AGENTS\.md is \d+ chars, over the Hermes context-file floor of 20000$/m);
  assert.doesNotMatch(run.stdout, /kernel is \d+ chars \(with/);
});
