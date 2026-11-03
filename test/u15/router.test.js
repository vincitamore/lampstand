// @ts-check
// `[reflexes] router = "full"` puts each reflex's whole text in the router's one Reflexes section. The section is
// still measured as the reflex-index surface, the AGENTS.md region carries it under its existing rules, and the OMP
// adapter appends exactly what the region left out.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runCompile } from "../../core/lib/constitution/run.js";
import { renderRegion, splitRouter } from "../../core/lib/init/region.js";
import { plant, plantHouse } from "../u2/helpers.js";
import { isolateProcessEnv, session, stubHost, tempDir } from "../u5/helpers.js";

const FULL = '[reflexes]\nrouter = "full"';

/**
 * A reflex whose body holds its own level-2 heading, so a split that looked for `## ` would cut it short.
 * @param {string} slug @param {string} scope
 */
function reflex(slug, scope) {
  const fields = [`scope: "${scope}"`, `summary: "${slug} in one line"`, `occasion: "${slug} happened"`, `falsified-when: "${slug} stops helping"`, `revise: "rewrite ${slug}"`, 'adopted: "2026-11-02"', `adopted-hash: "${"0".repeat(64)}"`];
  return `---\n${fields.join("\n")}\n---\nWhen ${slug} applies, do the careful thing first.\n\n## Why ${slug}\n\nBecause it was learned the hard way.\n`;
}

/** The whole text W and a full router carry for a reflex. @param {string} slug @param {string} scope */
function inFull(slug, scope) {
  return `### ${slug} (${scope})\n\n${slug} in one line\n\nWhen ${slug} applies, do the careful thing first.\n\n## Why ${slug}\n\nBecause it was learned the hard way.`;
}

/** @param {string} root @param {string} name */
function generated(root, name) {
  return readFileSync(join(root, ".house", "generated", name), "utf8");
}

/**
 * @param {import("../u5/helpers.js").TestContext} t
 * @param {{ extra?: string, reflexes: [string, string][] }} options
 */
function compiledHouse(t, options) {
  const dir = tempDir(t);
  isolateProcessEnv(t, dir);
  const root = join(dir, "house");
  plantHouse(root, { extra: options.extra });
  plant(root, Object.fromEntries(options.reflexes.map(([slug, scope]) => [`reflexes/${slug}.md`, reflex(slug, scope)])));
  const run = runCompile(root);
  assert.deepEqual(run.errors, []);
  return { root, run };
}

/** @param {string} text */
function sectionsOf(text) {
  return [...text.matchAll(/^<!-- lampstand:section:([a-z]+) -->$/gm)].map((m) => m[1]);
}

test("full reflexes: router.omp.md carries each reflex's whole text in one section; the default keeps index lines; W is unchanged", (t) => {
  const reflexes = /** @type {[string, string][]} */ ([["check-first", "behavioral"], ["read-anchor", "tool:omp"], ["hermes-only", "tool:hermes"]]);
  const index = compiledHouse(t, { reflexes });
  const full = compiledHouse(t, { reflexes, extra: FULL });

  const indexRouter = generated(index.root, "router.omp.md");
  assert.ok(indexRouter.includes("- check-first (behavioral): check-first in one line\n- read-anchor (tool:omp): read-anchor in one line"));
  assert.ok(!indexRouter.includes("do the careful thing first"));

  const router = generated(full.root, "router.omp.md");
  const { compiled } = full.run;
  const sections = splitRouter(router, compiled.kernel, compiled.manifest.surfaces, "omp");
  assert.deepEqual(sections.map((s) => s.name), ["principles", "charter", "reflexes", "voice"]);
  const body = /** @type {{ body: string }} */ (sections.find((s) => s.name === "reflexes")).body;
  assert.equal(body, `# Reflexes\n\nLearned working habits, one file each in this folder. The index that sessions load is derived from those files by\n\`lampstand compile\`; this file is its preface.\n\n${inFull("check-first", "behavioral")}\n\n${inFull("read-anchor", "tool:omp")}`);
  assert.equal(compiled.manifest.surfaces["reflex-index:omp"].chars, [...body].length, "the section is measured as the reflex-index surface");
  assert.equal(router.split("\n## Reflexes\n").length, 2, "one Reflexes section");

  // W differs only in its header's input hash (house.toml is an input), never in what it carries.
  const afterHeader = (/** @type {string} */ text) => text.slice(text.indexOf("\n"));
  for (const host of ["omp", "hermes"]) {
    assert.equal(afterHeader(generated(full.root, `worker.${host}.md`)), afterHeader(generated(index.root, `worker.${host}.md`)));
  }
});

test("full reflexes are capped by the reflex-index surface, which [surfaces.reflex-index] raises", (t) => {
  const dir = tempDir(t);
  isolateProcessEnv(t, dir);
  const root = join(dir, "house");
  plantHouse(root, { profile: "standard", lattice: false, extra: FULL });
  const long = "Look before you leap; read the anchor again after every edit. ";
  plant(root, { "reflexes/long.md": reflex("long", "behavioral").replace("do the careful thing first.", long.repeat(140)) });
  const refused = runCompile(root);
  assert.deepEqual(refused.errors.map((f) => f.message.replace(/ is \d+ chars/, "")), [
    "reflex-index:hermes, over its standard cap of 8000, and grew (no previous size)",
    "reflex-index:omp, over its standard cap of 8000, and grew (no previous size)",
    "worker:hermes, over its standard cap of 4000, and grew (no previous size)",
    "worker:omp, over its standard cap of 4000, and grew (no previous size)",
  ]);
  writeFileSync(join(root, "house.toml"), `${readFileSync(join(root, "house.toml"), "utf8")}\n[surfaces.reflex-index]\ncap = 12000\n[surfaces.worker]\ncap = 12000\n`);
  const raised = runCompile(root);
  assert.deepEqual(raised.errors, []);
  assert.equal(raised.compiled.manifest.surfaces["reflex-index:omp"].cap, 12000);
});

test("with full reflexes shared by both hosts, the region carries them and the adapter appends only what it left out", async (t) => {
  const { root, run } = compiledHouse(t, { reflexes: [["check-first", "behavioral"], ["keep-scope", "architectural"]], extra: FULL });
  const region = renderRegion(run.compiled);
  assert.deepEqual(sectionsOf(region), ["charter", "reflexes", "voice"], "the lattice's detail is too large; the full reflexes fit");
  assert.ok(region.includes(`${inFull("check-first", "behavioral")}\n\n${inFull("keep-scope", "architectural")}`));

  const host = await stubHost();
  const { ctx } = session(root);
  const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base", region] }, ctx);
  const added = result.systemPrompt[2];
  const { compiled } = run;
  const detail = splitRouter(generated(root, "router.omp.md"), compiled.kernel, compiled.manifest.surfaces, "omp")[0];
  const head = generated(root, "router.omp.md").split("\n", 2).join("\n");
  assert.equal(added, `${head}\n## Principle detail\n\n${detail.body}\n`);
  assert.equal(result.systemPrompt.join("\n").split("## Why check-first").length, 2, "the reflex text is carried once");
});

test("with a host-scoped reflex the region leaves the reflexes out, and the adapter appends them whole", async (t) => {
  const { root, run } = compiledHouse(t, { reflexes: [["check-first", "behavioral"], ["read-anchor", "tool:omp"]], extra: FULL });
  const region = renderRegion(run.compiled);
  assert.deepEqual(sectionsOf(region), ["charter", "voice"]);

  const host = await stubHost();
  const { ctx } = session(root);
  const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base", region] }, ctx);
  const added = result.systemPrompt[2];
  const { compiled } = run;
  const router = generated(root, "router.omp.md");
  const kept = splitRouter(router, compiled.kernel, compiled.manifest.surfaces, "omp").filter((s) => s.name === "principles" || s.name === "reflexes");
  assert.equal(added, `${router.split("\n", 2).join("\n")}\n${kept.map((s) => `## ${s.title}\n\n${s.body}`).join("\n\n")}\n`);
  assert.ok(added.endsWith(`${inFull("check-first", "behavioral")}\n\n${inFull("read-anchor", "tool:omp")}\n`));
  assert.doesNotMatch(added, /^## (Charter|Voice)$/m);
});
