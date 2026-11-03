// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePrincipleText, parseProvisionText, parseReflexText, parseVoiceText } from "../../core/lib/constitution/parse.js";
import { LATTICE_ADOPTED } from "./helpers.js";

const PROVENANCE = `origin: "own"\nadopted: "2026-11-02"\nadopted-hash: "${"0".repeat(64)}"`;

/** @param {string} body */
function own(body) {
  return `---\n${PROVENANCE}\n---\n${body}`;
}

test("every lattice principle parses with a thesis, facets and a failure mode; Borders and curation are trailing sections", () => {
  const file = parsePrincipleText(LATTICE_ADOPTED, "/house/principles/lattice.md");
  assert.deepEqual(
    file.principles.map((p) => p.mark),
    // Escapes keep this file free of symbol marks and em dashes; only the lattice pack may carry them.
    ["\u221e\u21920", "1\u21927", "\u25b3", "\u03a3\u21921", "\u2295", "\u2261", "\u222e", "\u22a2", "\u2551", "\u2609", "\u21bb", "\u2b1a", "\u25c7"],
  );
  for (const p of file.principles) {
    assert.ok(p.name.length > 0 && p.thesis.length > 0, `${p.mark} has a name and thesis`);
    assert.ok(!p.thesis.startsWith("*") && !p.thesis.endsWith("*"), `${p.mark} thesis is unwrapped`);
    assert.ok(p.facets.length >= 7, `${p.mark} has its facets`);
    assert.ok(p.failureMode && p.failureMode.label === "Vice" && p.failureMode.text.length > 0 && p.failureMode.summary.length > 0, `${p.mark} has a failure mode`);
  }
  assert.deepEqual(file.sections.map((s) => s.title), ["Borders", "Lattice curation discipline"]);
  assert.ok(file.preface.startsWith("## Principle Lattice"));
  const sun = /** @type {import("../../core/lib/constitution/parse.js").Principle} */ (file.principles.find((p) => p.mark === "\u2609"));
  assert.deepEqual(sun.facets.map((f) => f.name).slice(0, 3), ["grammar", "logic", "rhetoric"], "facets under group labels are read");
  assert.equal(sun.name, "Septem Artes Liberales \u2014 The Seven Liberal Arts");
});

test("both spellings of the failure-mode label are read; the kernel summary is the bold name or the first sentence", () => {
  const file = parsePrincipleText(
    own("Preface.\n\n### word : Plain\n\n*Thesis one.*\n\n- **a**: b\n\n*Failure mode:* Doing it blind. Then more.\n\n### star : Bold\n\n*Thesis two.*\n\n- **a**: b\n  continued\n\n*Vice:* **the named vice** and its forms.\n"),
    "/house/principles/own.md",
  );
  assert.equal(file.preface, "Preface.");
  assert.deepEqual(
    file.principles.map((p) => [p.mark, p.name, p.failureMode?.label, p.failureMode?.summary]),
    [
      ["word", "Plain", "Failure mode", "Doing it blind."],
      ["star", "Bold", "Vice", "the named vice"],
    ],
  );
  assert.equal(file.principles[1].facets[0].text, "b continued");
});

test("a principle with no failure mode parses with failureMode null, for the curation rule to report", () => {
  const file = parsePrincipleText(own("### A : B\n\n*T.*\n\n- **f**: g\n"), "/house/principles/own.md");
  assert.equal(file.principles[0].failureMode, null);
});

test("headings inside fenced code are text, not principles", () => {
  const file = parsePrincipleText(own("### A : B\n\n*T.*\n\n- **f**: g\n\n```\n### C : D\n```\n\n*Vice:* v.\n"), "/house/principles/own.md");
  assert.equal(file.principles.length, 1);
  assert.equal(file.principles[0].failureMode?.text, "v.");
});

test("principle files are refused by name and line when structure is missing", () => {
  /** @param {string} body @param {RegExp} pattern */
  const refused = (body, pattern) =>
    assert.throws(() => parsePrincipleText(own(body), "/house/principles/own.md"), (error) => {
      const e = /** @type {any} */ (error);
      return e.code === "E_SCHEMA" && pattern.test(e.message);
    });
  refused("### A : B\n\nNot italic.\n\n- **f**: g\n", /own\.md:8: principle A : B must open with an italic thesis/);
  refused("### A : B\n\n*T.*\n\n- plain bullet\n", /own\.md:6: principle A : B must list its facets/);
  refused("Just a preface.\n", /own\.md: a principle file must hold at least one heading/);
  assert.throws(() => parsePrincipleText("### A : B\n\n*T.*\n\n- **f**: g\n", "/house/principles/own.md"), /must open with a frontmatter block/);
  assert.throws(() => parsePrincipleText(own("### A : B\n\n*T.*\n\n- **f**: g\n"), "/house/principles/Own File.md"), /file name must be lowercase/);
  assert.throws(
    () => parsePrincipleText(`---\norigin: "elsewhere"\nadopted: "2026-11-02"\nadopted-hash: "${"0".repeat(64)}"\n---\n### A : B\n`, "/house/principles/own.md"),
    /origin must match/,
  );
});

test("a proposal needs a proposed date instead of adoption provenance", () => {
  const body = "### A : B\n\n*T.*\n\n- **f**: g\n\n*Vice:* v.\n";
  assert.doesNotThrow(() => parsePrincipleText(`---\noccasion: "x"\nproposed: "2026-11-02"\n---\n${body}`, "/h/proposals/principles/a.md", "proposal"));
  assert.throws(() => parsePrincipleText(`---\noccasion: "x"\n---\n${body}`, "/h/proposals/principles/a.md", "proposal"), /missing required key proposed/);
});

test("provisions open with a title; reflexes carry scope, summary and their curation fields", () => {
  const provision = parseProvisionText(
    `---\noccasion: "a push went out"\nadopted: "2026-11-02"\nadopted-hash: "${"0".repeat(64)}"\ngates: ["budget"]\n---\n\n# No pushes on Friday\n\nText.\n`,
    "/h/charter/provisions/no-friday.md",
  );
  assert.deepEqual([provision.slug, provision.title, provision.text, provision.gates, provision.occasion], ["no-friday", "No pushes on Friday", "Text.", ["budget"], "a push went out"]);
  assert.throws(() => parseProvisionText(`---\nadopted: "2026-11-02"\nadopted-hash: "${"0".repeat(64)}"\n---\nNo title.\n`, "/h/charter/provisions/x.md"), /must open with a `# <title>` line/);

  const reflex = parseReflexText(
    `---\nscope: "tool:omp"\nsummary: "Read before edit"\nadopted: "2026-11-02"\nadopted-hash: "${"0".repeat(64)}"\n---\nBody.\n`,
    "/h/reflexes/read-first.md",
  );
  assert.deepEqual([reflex.scope, reflex.summary, reflex.body, reflex.occasion, reflex.falsifiedWhen, reflex.revise], ["tool:omp", "Read before edit", "Body.", null, null, null]);
});

test("voice is read whole, with each level-2 heading a channel", () => {
  const voice = parseVoiceText("# Voice\n\nPlain words.\n\n## chat\n\nShort.\n\n## email\n\nFull sentences.\n", "/h/voice.md");
  assert.deepEqual(voice.channels, [
    { name: "chat", text: "Short." },
    { name: "email", text: "Full sentences." },
  ]);
  assert.ok(voice.text.startsWith("# Voice"));
});
