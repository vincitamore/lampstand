// @ts-check
// Update proposals: what upgrade offers when it must not replace the operator's file, and how adopt takes or strikes it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "../../core/lib/frontmatter.js";
import { readRecord, today } from "../../core/lib/constitution/curate.js";
import { adoptInteractively, settleActs } from "../../core/lib/constitution/verbs.js";
import { listAllProposals } from "../../core/lib/constitution/updates.js";
import { contentHash } from "../../core/lib/io.js";
import { commitNames, gitEnv } from "../u2/helpers.js";
import { answersToml, copyPackage, envelope, lampstand, read, SLOW, tempDir } from "./helpers.js";

const LATTICE_PROPOSAL = "proposals/updates/principles/lattice.md";

/** A committed house, and a package standing in for a newer lampstand whose lattice kernel line is reworded. */
function setup(/** @type {import("./helpers.js").TestContext} */ t) {
  const dir = tempDir(t);
  const house = join(dir, "house");
  const env = gitEnv(dir, true);
  writeFileSync(join(dir, "answers.toml"), answersToml());
  const planted = lampstand(["init", "house", "--answers", "answers.toml"], { cwd: dir, env, entryDir: dir });
  assert.equal(planted.status, 0, planted.stdout + planted.stderr);
  const pkg = copyPackage(join(dir, "pkg"));
  const pack = read(pkg, "packs/lattice/LATTICE.md");
  const first = /** @type {RegExpExecArray} */ (/^\*Kernel:\* (.+)$/m.exec(pack));
  writeFileSync(join(pkg, "packs", "lattice", "LATTICE.md"), pack.replace(first[0], "*Kernel:* A reworded kernel line from a newer pack."));
  /** @param {string[]} args @param {NodeJS.ProcessEnv} [as] */
  const run = (args, as = env) => lampstand(args, { cwd: house, env: as, pkg, entryDir: dir });
  const git = (/** @type {string[]} */ args) => spawnSync("git", args, { cwd: house, env, encoding: "utf8" }).stdout;
  return { dir, house, env, pkg, run, git, oldLine: first[1] };
}

test("adopting the lattice update puts the new pack in the kernel, keeps provenance, records the act and commits it; the next upgrade offers nothing", SLOW, (t) => {
  const s = setup(t);
  const upgraded = s.run(["upgrade"]);
  assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
  assert.match(upgraded.stdout, /proposed \(the lattice is your adopted copy and is never replaced; lampstand adopt takes the new pack text or strikes it\):\n {2}proposals\/updates\/principles\/lattice\.md/);
  assert.doesNotMatch(upgraded.stdout, /edited here/);
  const proposal = parseFrontmatter(read(s.house, LATTICE_PROPOSAL), LATTICE_PROPOSAL);
  assert.equal(proposal.frontmatter?.updates, "principles/lattice.md");
  assert.match(String(proposal.frontmatter?.["target-sha256"]), /^[0-9a-f]{64}$/);
  assert.match(proposal.body, /your own adopted copy of the pack, and upgrade never replaces it/);
  assert.ok(read(s.house, ".house/generated/kernel.md").includes(s.oldLine));

  const listed = s.run(["adopt"]);
  assert.match(listed.stdout, /=== update\/principles\/lattice\.md \(proposals\/updates\/principles\/lattice\.md\)\n/);
  assert.match(listed.stdout, /--- update\/principles\/lattice\.md: \d+ chars; principle-detail is \d+ of 36000/);

  const adopted = s.run(["adopt", "--ids", "update/principles/lattice.md", "--json"]);
  assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
  const value = envelope(adopted.stdout);
  assert.deepEqual(value.acts, [{ id: "update/principles/lattice.md", act: "adopted" }]);
  assert.equal(value.commit, s.git(["rev-parse", "HEAD"]).trim());
  assert.equal(s.git(["log", "-1", "--format=%s"]).trim(), "Adopt update/principles/lattice.md");

  const kernel = read(s.house, ".house/generated/kernel.md");
  assert.ok(kernel.includes("A reworded kernel line from a newer pack.") && !kernel.includes(s.oldLine), "the kernel carries the new line");
  const lattice = parseFrontmatter(read(s.house, "principles/lattice.md"), "lattice.md");
  assert.equal(lattice.frontmatter?.origin, "pack:lattice@1", "provenance is kept");
  assert.equal(lattice.frontmatter?.adopted, today());
  assert.equal(lattice.frontmatter?.["adopted-hash"], contentHash(lattice.body));
  assert.equal(lattice.body, read(s.pkg, "packs/lattice/LATTICE.md").replaceAll("\r\n", "\n"));
  assert.ok(!existsSync(join(s.house, LATTICE_PROPOSAL)));
  assert.deepEqual(readRecord(s.house).map((e) => [e.act, e.kind, e.slug]), [["adopted", "update", "principles/lattice.md"]]);

  const names = commitNames(s.house);
  for (const path of ["principles/lattice.md", "charter/record.md", LATTICE_PROPOSAL, ".house/planted.json", ".house/generated/kernel.md"]) assert.ok(names.includes(path), path);
  assert.equal(s.run(["compile", "--check"]).status, 0);

  const again = envelope(s.run(["upgrade", "--json"]).stdout);
  assert.deepEqual([again.updated, again.proposed, again.planted], [[], [], []], "the adopted pack is not offered again");
});

test("striking an update removes it, records the strike, and the same pack is not offered again until it changes", SLOW, async (t) => {
  const s = setup(t);
  s.run(["upgrade"]);
  const items = listAllProposals(s.house);
  assert.deepEqual(items.map((item) => item.id), ["update/principles/lattice.md"]);
  const talk = { show: () => {}, ask: async () => "strike", edit: () => false };
  const acts = await adoptInteractively(s.house, talk, "2026-11-03");
  assert.deepEqual(acts, [{ id: "update/principles/lattice.md", act: "struck" }]);
  const settled = settleActs(s.house, items, acts, s.env);
  assert.equal(settled.message, "Strike update/principles/lattice.md");
  assert.equal(settled.commit?.status, "committed");
  assert.deepEqual(commitNames(s.house), ["charter/record.md", LATTICE_PROPOSAL]);
  assert.ok(!existsSync(join(s.house, LATTICE_PROPOSAL)));
  assert.deepEqual(readRecord(s.house).map((e) => [e.act, e.kind, e.slug]), [["struck", "update", "principles/lattice.md"]]);

  const again = envelope(s.run(["upgrade", "--json"]).stdout);
  assert.deepEqual(again.proposed, [], "a struck offer is not made again");
  assert.ok(!existsSync(join(s.house, LATTICE_PROPOSAL)));

  const pack = read(s.pkg, "packs/lattice/LATTICE.md");
  writeFileSync(join(s.pkg, "packs", "lattice", "LATTICE.md"), `${pack}\nA still newer closing paragraph.\n`);
  assert.deepEqual(envelope(s.run(["upgrade", "--json"]).stdout).proposed, [LATTICE_PROPOSAL], "a changed pack is offered again");
});

test("an agent's shell cannot adopt an update; the proposal stays", SLOW, (t) => {
  const s = setup(t);
  s.run(["upgrade"]);
  const refused = s.run(["adopt", "--ids", "update/principles/lattice.md", "--json"], { ...s.env, LAMPSTAND_AGENT: "omp" });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  const value = envelope(refused.stdout);
  assert.equal(value.acts[0].code, "E_OPERATOR_ONLY");
  assert.match(value.acts[0].refused, /^update\/principles\/lattice\.md waits for the operator: an update to a planted file/);
  assert.ok(existsSync(join(s.house, LATTICE_PROPOSAL)));
  assert.ok(!read(s.house, ".house/generated/kernel.md").includes("A reworded kernel line"));
});

test("a target edited after the proposal was written is not overwritten", SLOW, (t) => {
  const s = setup(t);
  s.run(["upgrade"]);
  appendFileSync(join(s.house, "principles", "lattice.md"), "\nOur own closing line.\n");
  const edited = read(s.house, "principles/lattice.md");
  const refused = s.run(["adopt", "--ids", "update/principles/lattice.md", "--json"]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(envelope(refused.stdout).acts[0].refused, /principles\/lattice\.md changed after this update was proposed, so it is not overwritten/);
  assert.equal(read(s.house, "principles/lattice.md"), edited);
  assert.ok(existsSync(join(s.house, LATTICE_PROPOSAL)));
  assert.deepEqual(readRecord(s.house), []);
});

test("a planted file the operator edited gets an update proposal that adopt takes whole, and planted.json then counts the file as unedited", SLOW, (t) => {
  const s = setup(t);
  appendFileSync(join(s.pkg, "templates", "constitution", "curation.md"), "\nA newer curation line.\n");
  appendFileSync(join(s.house, "curation.md"), "\nOur own curation line.\n");
  const upgraded = s.run(["upgrade"]);
  assert.match(upgraded.stdout, /proposed \(edited here, left as they are; lampstand adopt takes or strikes each\):\n {2}proposals\/updates\/curation\.md/);
  assert.ok(read(s.house, "proposals/updates/curation.md").includes("`lampstand adopt` takes it as it is (it is listed as `update/curation.md`)"));

  const adopted = s.run(["adopt", "--ids", "update/curation.md", "--json"]);
  assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
  assert.equal(read(s.house, "curation.md"), read(s.pkg, "templates/constitution/curation.md"));
  // upgrade already recorded the offered text as planted, so adopting it leaves planted.json as it is.
  const planted = JSON.parse(read(s.house, ".house/planted.json")).files["curation.md"];
  assert.equal(planted.sha256, contentHash(read(s.house, "curation.md")));
  assert.deepEqual(commitNames(s.house).filter((name) => !name.startsWith(".house/generated/")), ["charter/record.md", "curation.md", "proposals/updates/curation.md"]);

  appendFileSync(join(s.pkg, "templates", "constitution", "curation.md"), "\nAnd one more.\n");
  const next = envelope(s.run(["upgrade", "--json"]).stdout);
  assert.deepEqual(next.updated, ["curation.md"], "the adopted copy is unedited, so the next change replaces it");
});

test("a lattice proposal written by 0.2.0, which recorded no target hash, still adopts while the copy is as adopted", SLOW, (t) => {
  const s = setup(t);
  s.run(["upgrade"]);
  const parsed = parseFrontmatter(read(s.house, LATTICE_PROPOSAL), LATTICE_PROPOSAL);
  const fm = /** @type {Record<string, unknown>} */ (parsed.frontmatter);
  const fence = /** @type {string} */ (parsed.body.split("\n").find((line) => /^`{3,}$/.test(line)));
  const lines = parsed.body.split("\n");
  const text = `${lines.slice(lines.indexOf(fence) + 1, lines.lastIndexOf(fence)).join("\n")}\n`;
  const legacy = `---\nupdates: "${fm.updates}"\nplanted-sha256: "${fm["planted-sha256"]}"\nupstream-sha256: "${contentHash(text)}"\n---\n${parsed.body}`;
  writeFileSync(join(s.house, LATTICE_PROPOSAL), legacy);
  const adopted = s.run(["adopt", "--ids", "update/principles/lattice.md", "--json"]);
  assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
  assert.ok(read(s.house, ".house/generated/kernel.md").includes("A reworded kernel line from a newer pack."));
});
