// @ts-check
// Caps come from house.toml [surfaces] when the operator sets them, else from the budget profile; a host's own limit
// is a hard cap only where that host imposes one; and a raise and the growth it allows never land in one compile.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DELEGATE_RESERVE, HERMES_DELEGATE_CONTEXT_CHARS, HOST_LIMITS, KERNEL_FRAMING_CHARS, KERNEL_HOST_LIMIT, chars } from "../../core/lib/constitution/budgets.js";
import { listProposals, sizeLine } from "../../core/lib/constitution/curate.js";
import { budgetFindings, projectionMarker } from "../../core/lib/constitution/compile.js";
import { runCompile } from "../../core/lib/constitution/run.js";
import { doctor, edit, plantHouse as initHouse, SLOW } from "../u10/helpers.js";
import { envelope, git, isolatedEnv, lampstand, plant, plantHouse, REPO, tempDir } from "../u2/helpers.js";

/** @param {string} root @param {string} toml */
function appendToml(root, toml) {
  writeFileSync(join(root, "house.toml"), `${readFileSync(join(root, "house.toml"), "utf8")}\n${toml}\n`);
}

/** @param {string} root */
function commitAll(root) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "step"]);
}

/** A reflex whose body is `n` characters of prose. @param {string} slug @param {string} scope @param {number} n */
function longReflex(slug, scope, n) {
  const fields = [`scope: "${scope}"`, `summary: "${slug} summary"`, `occasion: "${slug} happened"`, `falsified-when: "${slug} stops helping"`, `revise: "rewrite ${slug}"`, 'adopted: "2026-11-02"', `adopted-hash: "${"0".repeat(64)}"`];
  const line = "Check the thing before reporting it done. ";
  return `---\n${fields.join("\n")}\n---\n${line.repeat(Math.ceil(n / line.length)).slice(0, n).trim()}\n`;
}

const PRINCIPLE_PROPOSAL = '---\noccasion: "a review found drift"\nproposed: "2026-11-02"\n---\n### S : Stewardship\n\n*Leave it better.*\n\n- **care**: tidy as you go\n\n*Vice:* neglect.\n';

test("a house over its profile caps compiles once [surfaces] raises them, and adopt's size lines use the raised cap", (t) => {
  const root = tempDir(t);
  plantHouse(root, { profile: "standard" });
  plant(root, { "proposals/principles/stewardship.md": PRINCIPLE_PROPOSAL });
  const refused = runCompile(root);
  assert.deepEqual(refused.errors.map((f) => f.message.split(" ")[0]), ["principle-detail"]);
  assert.match(sizeLine(listProposals(root)[0]), /; principle-detail is \d+ of 12000$/);

  appendToml(root, "[surfaces.principle-detail]\ncap = 40000");
  const raised = runCompile(root);
  assert.deepEqual(raised.errors, []);
  const surfaces = raised.compiled.manifest.surfaces;
  assert.equal(surfaces["principle-detail"].cap, 40000);
  assert.ok(surfaces["principle-detail"].chars > 12000);
  assert.equal(surfaces["charter-core"].cap, 6000, "a surface [surfaces] does not name keeps its profile cap");
  assert.match(sizeLine(listProposals(root)[0]), /; principle-detail is \d+ of 40000$/);

  const env = isolatedEnv(root);
  const check = lampstand(["compile", "--check", "--json"], { cwd: root, env });
  assert.equal(check.status, 0, check.stdout);
  assert.equal(envelope(check.stdout).surfaces["principle-detail"].cap, 40000);
});

test("a cap raised in the same compile that grows its surface past the old cap is refused with the two-step remedy", (t) => {
  const root = tempDir(t);
  plantHouse(root, { profile: "standard", lattice: false });
  git(root, ["init", "-q"]);
  assert.deepEqual(runCompile(root).errors, []);
  commitAll(root);

  const core = join(root, "charter", "core.md");
  const original = readFileSync(core, "utf8");
  const grown = `${original}\n${"More charter text for the house to work under. ".repeat(140)}\n`;
  appendToml(root, "[surfaces.charter-core]\ncap = 9000");
  writeFileSync(core, grown);
  const both = runCompile(root);
  assert.deepEqual(both.errors.map((f) => f.rule), ["budget"]);
  assert.match(
    both.errors[0].message,
    /^charter-core: its cap rises from 6000 to 9000 in the same change that grows it from \d+ to \d+; do it in two steps: raise \[surfaces\.charter-core\]\.cap alone, compile and commit; then grow the text in a later commit$/,
  );
  assert.ok(both.compiled.manifest.surfaces["charter-core"].chars > 6000);
  assert.deepEqual(both.written, [], "a refused compile writes nothing");

  // The remedy: the raise alone, compiled and committed; then the growth.
  writeFileSync(core, original);
  assert.deepEqual(runCompile(root).errors, []);
  commitAll(root);
  writeFileSync(core, grown);
  const after = runCompile(root);
  assert.deepEqual(after.errors, []);
  assert.equal(after.compiled.manifest.surfaces["charter-core"].cap, 9000);
});

test("the kernel cap never rises above 4,000; an operator's lower kernel cap is held by the ratchet", (t) => {
  const root = tempDir(t);
  plantHouse(root, { extra: "[surfaces.kernel]\ncap = 4001" });
  const refused = runCompile(root);
  assert.deepEqual(refused.errors.map((f) => f.rule), ["budget"]);
  assert.match(refused.errors[0].message, /^kernel: \[surfaces\.kernel\]\.cap is 4001, above 4000, the most a host loads/);
  assert.deepEqual(refused.written, []);

  const lowered = tempDir(t);
  plantHouse(lowered, { extra: "[surfaces.kernel]\ncap = 1000" });
  const run = runCompile(lowered);
  const kernel = run.compiled.manifest.surfaces.kernel;
  assert.ok(kernel.chars > 1000 && kernel.chars <= KERNEL_HOST_LIMIT);
  assert.deepEqual(run.errors.map((f) => f.message), [`kernel is ${kernel.chars} chars, over its [surfaces.kernel] cap of 1000, and grew (no previous size)`]);
});

test("the worker cap rises freely on OMP and stops at Hermes's subagent context limit, which always holds", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  plant(root, { "reflexes/long.md": longReflex("long", "behavioral", 6000) });
  const defaults = runCompile(root);
  assert.deepEqual(defaults.errors.map((f) => f.message.replace(/ is \d+ chars/, "")), [
    "worker:hermes, over its large cap of 4000, and grew (no previous size)",
    "worker:omp, over its large cap of 4000, and grew (no previous size)",
  ]);

  appendToml(root, "[surfaces.worker]\ncap = 30000");
  const raised = runCompile(root);
  assert.deepEqual(raised.errors, []);
  assert.equal(raised.compiled.manifest.surfaces["worker:omp"].cap, 30000);
  assert.equal(raised.compiled.manifest.surfaces["worker:hermes"].cap, HOST_LIMITS["worker:hermes"]);

  // Past Hermes's limit, W on Hermes is refused even at the size it had before; W on OMP passes under its raised cap.
  plant(root, { "reflexes/long.md": longReflex("long", "behavioral", 21000) });
  const { manifest } = runCompile(root).compiled;
  const size = manifest.surfaces["worker:hermes"].chars;
  assert.ok(manifest.surfaces["worker:omp"].chars > 20000);
  assert.deepEqual(
    budgetFindings(manifest, manifest, "rules").filter((f) => f.level === "error").map((f) => f.message),
    [`worker:hermes is ${size} chars, over its hard cap of 20000`],
  );
});

test("W at its Hermes cap, beside a kernel at its limit and any shipped role brief, fits Hermes's subagent context", () => {
  // lampstand_delegate sends W's body (marker line, K, sections), then the role brief, then the caller's context.
  const marker = chars(projectionMarker("worker:hermes"));
  const largestW = marker + 1 + (KERNEL_HOST_LIMIT - KERNEL_FRAMING_CHARS) + HOST_LIMITS["worker:hermes"];
  assert.ok(largestW <= HERMES_DELEGATE_CONTEXT_CHARS - DELEGATE_RESERVE);
  const dir = join(REPO, "agents");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".md"))) {
    const brief = readFileSync(join(dir, name), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    assert.ok(chars(brief) + 4 <= DELEGATE_RESERVE / 2, `agents/${name} leaves the caller less than half the reserve`);
  }
});

test("doctor agrees: a kernel cap above 4,000 and a Hermes worker over its limit are outside the host envelope", SLOW, (t) => {
  const { env, root } = initHouse(t);
  appendToml(root, "[surfaces.kernel]\ncap = 5000\n[surfaces.worker]\ncap = 30000");
  plant(root, { "reflexes/long.md": longReflex("long", "behavioral", 21000) });
  const report = doctor(env, root);
  const over = report.findings.filter((finding) => finding.code === "BUDGET_OVER_ENVELOPE").map((finding) => finding.message);
  assert.equal(over.length, 2, JSON.stringify(report.findings));
  assert.equal(over[0], "kernel: its cap is 5000; hosts load at most 4000");
  assert.match(over[1], /^worker:hermes is \d+ chars; hosts load at most 20000$/);
  assert.equal(report.exit, 2);

  // Within the envelopes a raised cap is no doctor finding at all.
  edit(root, "house.toml", "cap = 5000", "cap = 4000");
  plant(root, { "reflexes/long.md": longReflex("long", "behavioral", 12000) });
  assert.deepEqual(doctor(env, root).findings.filter((finding) => finding.code === "BUDGET_OVER_ENVELOPE"), []);
});
