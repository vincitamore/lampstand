// @ts-check
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chars, KERNEL_FRAMING_CHARS } from "../../core/lib/constitution/budgets.js";
import { compileHouse, projectionMarker, readHeader, renderKernel, withoutKernelLines, withProjection } from "../../core/lib/constitution/compile.js";
import { inputHash, loadHouse, readInputs } from "../../core/lib/constitution/house.js";
import { HOSTS } from "../../core/lib/constitution/parse.js";
import { runCompile } from "../../core/lib/constitution/run.js";
import { envelope, git, isolatedEnv, LATTICE, lampstand, plant, plantHouse, reflexFile, tempDir } from "./helpers.js";

const PROJECTIONS = ["kernel.md", "router.hermes.md", "router.omp.md", "worker.hermes.md", "worker.omp.md", "watchdog.md"];

/** @param {string} root @param {string} name */
function generated(root, name) {
  return readFileSync(join(root, ".house", "generated", name), "utf8");
}

/** The text after a projection's header and marker lines. @param {string} text */
function afterMarker(text) {
  return text.split("\n").slice(2).join("\n");
}

test("the lattice house compiles: K fits 4,000 chars after Hermes framing and R fits the large profile", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  const run = runCompile(root);
  assert.deepEqual(run.errors, []);
  const kernel = run.compiled.kernel;
  const framed = KERNEL_FRAMING_CHARS + chars(kernel);
  assert.equal(run.compiled.manifest.surfaces.kernel.chars, framed);
  assert.ok(framed <= 4000, `framed kernel is ${framed} chars`);
  const detail = run.compiled.manifest.surfaces["principle-detail"];
  assert.equal(detail.cap, 36000);
  assert.ok(detail.chars <= detail.cap);
  const principleLines = /** @type {string} */ (kernel.split("\n\n").find((block) => block.startsWith("Principles:"))).split("\n").slice(1);
  assert.equal(principleLines.length, 13, "one kernel line per lattice principle");
  assert.ok(principleLines.every((line) => !/ Failure mode: /.test(line)), "each carries its *Kernel:* line, not its thesis and failure mode");
  assert.ok(framed < 3500, `a fresh lattice house is under the kernel target: ${framed}`);
  assert.ok(!kernel.includes("Borders") && !kernel.includes("curation discipline"), "the lattice's trailing sections stay out of K");
  const router = generated(root, "router.omp.md");
  assert.ok(router.includes("### Borders") && router.includes("### Lattice curation discipline"), "trailing sections reach R detail");
});

test("identical kernel bytes: K comes first, byte for byte, in every projection", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  plant(root, { "reflexes/check-first.md": reflexFile("check-first", "behavioral") });
  const { kernel } = runCompile(root).compiled;
  for (const name of PROJECTIONS) {
    const body = afterMarker(generated(root, name));
    assert.ok(body.startsWith(kernel), `${name} opens with K`);
    const next = body.slice(kernel.length);
    assert.ok(next === "\n" || next.startsWith("\n\n## "), `${name}: K is followed by the end or a section, got ${JSON.stringify(next.slice(0, 20))}`);
  }
});

test("role-scoped: R and W contain K; only R carries detail and voice; G carries failure modes and ask-first lines", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  plant(root, { "reflexes/check-first.md": reflexFile("check-first", "behavioral") });
  const { kernel } = runCompile(root).compiled;
  for (const host of HOSTS) {
    const router = generated(root, `router.${host}.md`);
    const worker = generated(root, `worker.${host}.md`);
    assert.ok(router.includes(kernel) && worker.includes(kernel));
    assert.ok(router.includes("## Principle detail") && router.includes("## Charter") && router.includes("## Voice"));
    assert.ok(router.includes("- check-first (behavioral): check-first summary line"), "R carries the reflex index entry");
    assert.ok(!worker.includes("## Principle detail") && !worker.includes("## Voice"));
    assert.ok(worker.includes("Body of check-first."), "W carries the reflex in full");
  }
  const watchdog = generated(root, "watchdog.md");
  assert.ok(watchdog.includes("## Failure modes") && watchdog.includes("**inversion without load** \u2014 under-engineering as license"));
  assert.ok(watchdog.includes("## Ask first\n\n- Ask before pushing to any remote."));
  assert.ok(!watchdog.includes("## Principle detail"));
});

test("host-scoped reflexes: tool:<host> reaches only that host's R and W; behavioral and architectural reach both", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  plant(root, {
    "reflexes/omp-tool.md": reflexFile("omp-tool", "tool:omp"),
    "reflexes/hermes-tool.md": reflexFile("hermes-tool", "tool:hermes"),
    "reflexes/layering.md": reflexFile("layering", "architectural"),
  });
  runCompile(root);
  for (const host of HOSTS) {
    const other = host === "omp" ? "hermes" : "omp";
    for (const name of [`router.${host}.md`, `worker.${host}.md`]) {
      const text = generated(root, name);
      assert.ok(text.includes(`${host}-tool`), `${name} carries its own host's reflex`);
      assert.ok(!text.includes(`${other}-tool`), `${name} must not carry ${other}'s reflex`);
      assert.ok(text.includes("layering"), `${name} carries the architectural reflex`);
    }
  }
  assert.ok(!generated(root, "kernel.md").includes("omp-tool") && !generated(root, "watchdog.md").includes("layering"));
});

test("a reflex scoped to an unknown host is refused with its path", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  plant(root, { "reflexes/odd.md": reflexFile("odd", "tool:vim") });
  assert.throws(() => loadHouse(root), (error) => /** @type {any} */ (error).code === "E_SCHEMA" && /odd\.md/.test(String(error)));
});

test("marker-idempotent: a context already carrying a projection's marker does not get it twice", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  runCompile(root);
  const kernel = generated(root, "kernel.md");
  const router = generated(root, "router.omp.md");
  const once = withProjection("host preamble", kernel);
  assert.equal(withProjection(once, kernel), once);
  const both = withProjection(once, router);
  assert.notEqual(both, once, "a different projection's marker does not block it");
  assert.equal(withProjection(both, router), both);
  assert.equal(both.split(projectionMarker("kernel")).length - 1, 1);
  assert.equal(both.split(projectionMarker("router:omp")).length - 1, 1);
});

test("provenance: every projection opens with the GENERATED header whose input hash recomputes from its named inputs", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  plant(root, { "reflexes/check-first.md": reflexFile("check-first", "behavioral"), "purpose.md": "Long form, not an input.\n" });
  runCompile(root);
  const inputs = readInputs(root);
  assert.deepEqual(
    inputs.map((input) => input.path),
    ["house.toml", "principles/lattice.md", "charter/core.md", "reflexes/INDEX.md", "reflexes/check-first.md", "voice.md"],
  );
  for (const name of PROJECTIONS) {
    const header = readHeader(generated(root, name));
    assert.ok(header, `${name} carries the header`);
    assert.deepEqual(header.inputs, ["house.toml", "principles/*.md", "charter/core.md", "charter/provisions/*.md", "reflexes/*.md", "voice.md"]);
    assert.equal(header.inputHash, inputHash(inputs));
  }
  const manifest = JSON.parse(generated(root, "manifest.json"));
  assert.equal(manifest["input-hash"], inputHash(inputs));
  assert.equal(manifest.profile, "large");
  assert.deepEqual(Object.keys(manifest.projections), PROJECTIONS);
  assert.ok(!("total" in manifest) && !Object.keys(manifest.surfaces).some((key) => /total/.test(key)), "no declared totals");
});

test("single source: one edit to a principle reaches every projection and nothing else changes it", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  runCompile(root);
  const before = new Map(PROJECTIONS.map((name) => [name, generated(root, name)]));
  const path = join(root, "principles", "lattice.md");
  const line = "*Kernel:* Relocate, do not reduce: find the frame where the great sits at the humble point, and keep the load it must bear.";
  assert.ok(readFileSync(path, "utf8").includes(line), "the pack's first kernel line");
  writeFileSync(path, readFileSync(path, "utf8").replace(line, "*Kernel:* Find the frame that shows it."));
  const run = runCompile(root);
  assert.deepEqual(run.errors, []);
  for (const name of PROJECTIONS) {
    const text = generated(root, name);
    assert.notEqual(text, before.get(name), `${name} reflects the edit`);
    assert.ok(text.includes("Find the frame that shows it."), name);
    assert.ok(!text.includes("Relocate, do not reduce: find the frame"), `${name} carries no copy of the old text`);
  }
});

test("compile is deterministic: compiling the same house twice gives the same bytes", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  const first = compileHouse(loadHouse(root)).files;
  const second = compileHouse(loadHouse(root)).files;
  assert.deepEqual(first, second);
});

test("fail loud: a principle without a thesis is refused with its path and line, and nothing is written", (t) => {
  const root = tempDir(t);
  plantHouse(root, { lattice: false });
  plant(root, {
    "principles/own.md": '---\norigin: "own"\noccasion: "x"\nadopted: "2026-11-02"\nadopted-hash: "' + "0".repeat(64) + '"\n---\n### A : Name\n\nNo italics here.\n\n- **f**: g\n',
  });
  const result = lampstand(["compile", "--json"], { cwd: root, env: isolatedEnv(root) });
  assert.equal(result.status, 1);
  const value = envelope(result.stdout);
  assert.equal(value.error.code, "E_SCHEMA");
  assert.match(value.error.message, /own\.md:\d+: principle A : Name must open with an italic thesis/);
  assert.ok(!existsSync(join(root, ".house", "generated")));
});

test("fail loud: a principle without a failure mode fails the failure-mode rule and nothing is written", (t) => {
  const root = tempDir(t);
  plantHouse(root, { lattice: false });
  plant(root, {
    "principles/own.md": '---\norigin: "own"\noccasion: "x"\nadopted: "2026-11-02"\nadopted-hash: "' + "0".repeat(64) + '"\n---\n### A : Name\n\n*Thesis.*\n\n- **f**: g\n',
  });
  const result = lampstand(["compile", "--json"], { cwd: root, env: isolatedEnv(root) });
  assert.equal(result.status, 1, result.stderr);
  const value = envelope(result.stdout);
  assert.equal(value.ok, false);
  assert.deepEqual(value.findings.map((/** @type {any} */ f) => [f.rule, f.level, f.path]), [["failure-mode", "error", "principles/own.md:7"]]);
  assert.ok(!existsSync(join(root, ".house", "generated")));
});

test("budgeted: a kernel over its hard cap is refused even with no previous size", (t) => {
  const root = tempDir(t);
  plantHouse(root, { askFirst: Array.from({ length: 30 }, (_, k) => `Ask before step ${k}: ${"y".repeat(60)}`), purpose: "p".repeat(600) });
  const run = runCompile(root);
  const kernel = run.compiled.manifest.surfaces.kernel;
  assert.ok(kernel.chars > 4000, `kernel measured ${kernel.chars}`);
  assert.deepEqual(run.errors.map((f) => f.rule), ["budget"]);
  assert.match(run.errors[0].message, /^kernel is \d+ chars, over its hard cap of 4000$/);
  assert.deepEqual(run.written, []);
});

test("budgeted: the lattice under the standard profile is refused when there is no previous size", (t) => {
  const root = tempDir(t);
  plantHouse(root, { profile: "standard" });
  const run = runCompile(root);
  assert.deepEqual(run.errors.map((f) => f.message.split(" ")[0]), ["principle-detail"]);
  assert.match(run.errors[0].message, /over its standard cap of 12000, and grew \(no previous size\)/);
});

test("kernel size is measured after the framing Hermes renders around the kernel section", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  const house = loadHouse(root);
  const { manifest } = compileHouse(house);
  // Hermes's own section framing for the kernel's id, as hermes_cli renders it.
  assert.equal(KERNEL_FRAMING_CHARS, 79);
  assert.equal(manifest.surfaces.kernel.chars, KERNEL_FRAMING_CHARS + chars(renderKernel(house)));
});

test("compile --check passes on fresh projections and exits 1 naming each stale one after a planted input edit", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  const env = isolatedEnv(root);
  assert.equal(lampstand(["compile"], { cwd: root, env }).status, 0);
  const fresh = lampstand(["compile", "--check", "--json"], { cwd: root, env });
  assert.equal(fresh.status, 0, fresh.stdout);
  assert.deepEqual(envelope(fresh.stdout).stale, []);

  writeFileSync(join(root, "voice.md"), `${readFileSync(join(root, "voice.md"), "utf8")}\n## email\n\nFull sentences.\n`);
  const stale = lampstand(["compile", "--check", "--json"], { cwd: root, env });
  assert.equal(stale.status, 1);
  const value = envelope(stale.stdout);
  assert.equal(value.ok, false);
  assert.deepEqual(value.stale, PROJECTIONS.concat("manifest.json").map((name) => `.house/generated/${name}`));
  const text = lampstand(["compile", "--check"], { cwd: root, env });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^stale: \.house\/generated\/kernel\.md, /);
});

test("compile --check names a hand-edited projection and one whose header was removed", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  runCompile(root);
  const watchdog = join(root, ".house", "generated", "watchdog.md");
  writeFileSync(watchdog, `${readFileSync(watchdog, "utf8")}hand edit\n`);
  const kernel = join(root, ".house", "generated", "kernel.md");
  writeFileSync(kernel, afterMarker(readFileSync(kernel, "utf8")));
  const run = runCompile(root, { check: true });
  assert.deepEqual(
    run.findings.filter((f) => f.rule === "generated-fresh").map((f) => f.message),
    [".house/generated/kernel.md has no GENERATED header", ".house/generated/watchdog.md is stale: it differs from a fresh compile"],
  );
});

test("the ratchet refuses a grown over-cap surface and passes a shrinking one", (t) => {
  const root = tempDir(t);
  plantHouse(root, { mode: "none" });
  git(root, ["init", "-q"]);
  assert.deepEqual(runCompile(root).errors, []);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "large"]);

  // Lowering the profile leaves principle detail over its new cap but not grown: it passes, as information.
  writeFileSync(join(root, "house.toml"), readFileSync(join(root, "house.toml"), "utf8").replace('profile = "large"', 'profile = "standard"'));
  const lowered = runCompile(root);
  assert.deepEqual(lowered.errors, []);
  assert.ok(lowered.findings.some((f) => f.level === "info" && /principle-detail is \d+ chars, over its cap of 12000; it did not grow/.test(f.message)));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "standard"]);

  const lattice = join(root, "principles", "lattice.md");
  const original = readFileSync(lattice, "utf8");
  writeFileSync(lattice, `${original}\nOne more paragraph of detail.\n`);
  const grown = runCompile(root);
  assert.deepEqual(grown.errors.map((f) => f.rule), ["budget"]);
  assert.match(grown.errors[0].message, /^principle-detail is \d+ chars, over its standard cap of 12000, and grew \(\d+ at the previous commit\)$/);
  assert.deepEqual(grown.written, [], "a refused compile writes nothing");

  writeFileSync(lattice, original.replace(/\n### \u25c7 : Primitives Over Opinions[\s\S]*?(?=\n### Borders)/, ""));
  const shrunk = runCompile(root);
  assert.deepEqual(shrunk.errors, []);
  assert.ok(shrunk.written.includes(".house/generated/kernel.md"));
});

test("in rules mode, raising a cap and growing its surface in one change is refused", (t) => {
  const root = tempDir(t);
  plantHouse(root, { profile: "standard", lattice: false });
  git(root, ["init", "-q"]);
  assert.deepEqual(runCompile(root).errors, []);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "standard"]);
  writeFileSync(join(root, "house.toml"), readFileSync(join(root, "house.toml"), "utf8").replace('profile = "standard"', 'profile = "large"'));
  writeFileSync(join(root, "voice.md"), `${readFileSync(join(root, "voice.md"), "utf8")}\nMore.\n`);
  plant(root, { "charter/core.md": `${readFileSync(join(root, "charter", "core.md"), "utf8")}\nMore charter.\n` });
  const run = runCompile(root);
  assert.deepEqual(run.errors.map((f) => f.message.split(":")[0]), ["charter-core"]);
  assert.match(run.errors[0].message, /its cap rises from 6000 to 8000 in the same change that grows it/);
});

test("the lattice text is carried verbatim into R detail, less the *Kernel:* lines the kernel already carries", (t) => {
  const root = tempDir(t);
  plantHouse(root);
  runCompile(root);
  const router = generated(root, "router.hermes.md");
  const detail = withoutKernelLines(LATTICE.replaceAll("\r\n", "\n")).trim();
  assert.ok(router.includes(detail));
  assert.ok(!router.includes("*Kernel:*"), "the detail repeats no kernel line");
  assert.ok(LATTICE.includes("*Kernel:*") && detail.length < LATTICE.trim().length);
});
