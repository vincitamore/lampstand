// @ts-check
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { draftProblems, readRecord, today } from "../../core/lib/constitution/curate.js";
import { PROPOSAL_EXAMPLES } from "../../core/lib/constitution/examples.js";
import { parseReflexText } from "../../core/lib/constitution/parse.js";
import { adoptInteractively } from "../../core/lib/constitution/verbs.js";
import { contentHash } from "../../core/lib/io.js";
import { envelope, isolatedEnv, lampstand, plant, plantHouse, tempDir } from "./helpers.js";

const REFLEX_DRAFT = '---\nscope: "tool:omp"\nsummary: "Read the file before editing it"\nfalsified-when: "edits land clean without reading"\nrevise: "narrow it to large files"\n---\nRead first; the anchor must be fresh.\n';
const PRINCIPLE_DRAFT = "---\n---\n### so : Stewardship\n\n*Leave the house better than you found it.*\n\n- **practical**: tidy what you touch.\n\n*Failure mode:* Polishing what nobody uses.\n";

/** @param {string} root */
function setup(root) {
  plantHouse(root);
  plant(root, { "drafts/read-first.md": REFLEX_DRAFT, "drafts/stewardship.md": PRINCIPLE_DRAFT });
  return isolatedEnv(root);
}

test("propose needs an occasion and a known kind", (t) => {
  const root = tempDir(t);
  const env = setup(root);
  const missing = lampstand(["propose", "reflex", "drafts/read-first.md", "--json"], { cwd: root, env });
  assert.equal(missing.status, 64);
  assert.match(envelope(missing.stdout).error.message, /needs --occasion/);
  const kind = lampstand(["propose", "habit", "drafts/read-first.md", "--occasion", "x", "--json"], { cwd: root, env });
  assert.equal(kind.status, 64);
  assert.ok(!existsSync(join(root, "proposals")));
});

test("propose then adopt --ids: the reflex lands with provenance, is recorded, and reaches only its host's projections", (t) => {
  const root = tempDir(t);
  const env = setup(root);
  const proposed = lampstand(["propose", "reflex", "drafts/read-first.md", "--occasion", "an edit landed on a stale anchor", "--json"], { cwd: root, env });
  assert.equal(proposed.status, 0, proposed.stdout + proposed.stderr);
  assert.equal(envelope(proposed.stdout).path, "proposals/reflexes/read-first.md");
  const proposal = readFileSync(join(root, "proposals", "reflexes", "read-first.md"), "utf8");
  assert.match(proposal, /^---\nscope: "tool:omp"\n[\s\S]*occasion: "an edit landed on a stale anchor"\nproposed: "\d{4}-\d{2}-\d{2}"\n---\nRead first;/);

  const adopted = lampstand(["adopt", "--ids", "reflex/read-first", "--json"], { cwd: root, env });
  assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
  const value = envelope(adopted.stdout);
  assert.deepEqual(value.acts, [{ id: "reflex/read-first", act: "adopted" }]);
  assert.equal(value.proposed[0].surface, "reflex-index");

  assert.ok(!existsSync(join(root, "proposals", "reflexes", "read-first.md")), "adopting moves the file out of proposals");
  const reflexPath = join(root, "reflexes", "read-first.md");
  const reflex = parseReflexText(readFileSync(reflexPath, "utf8"), reflexPath);
  assert.equal(reflex.frontmatter.adopted, today());
  assert.equal(reflex.frontmatter["adopted-hash"], contentHash("Read first; the anchor must be fresh.\n"));
  assert.equal(reflex.occasion, "an edit landed on a stale anchor");
  assert.deepEqual(readRecord(root).map((e) => [e.act, e.kind, e.slug, e.hash]), [["adopted", "reflex", "read-first", contentHash("Read first; the anchor must be fresh.\n")]]);
  assert.match(readFileSync(join(root, "charter", "record.md"), "utf8"), /sha256:[0-9a-f]{64} occasion: an edit landed on a stale anchor\n$/);

  const omp = readFileSync(join(root, ".house", "generated", "router.omp.md"), "utf8");
  const hermes = readFileSync(join(root, ".house", "generated", "router.hermes.md"), "utf8");
  assert.ok(omp.includes("- read-first (tool:omp): Read the file before editing it"));
  assert.ok(!hermes.includes("read-first"));
  assert.equal(lampstand(["compile", "--check"], { cwd: root, env }).status, 0, "adopt leaves the projections fresh");
});

test("adopt without --ids off a terminal shows every item verbatim with its size and adopts nothing", (t) => {
  const root = tempDir(t);
  const env = setup(root);
  lampstand(["propose", "principle", "drafts/stewardship.md", "--occasion", "the house drifted"], { cwd: root, env });
  lampstand(["propose", "reflex", "drafts/read-first.md", "--occasion", "stale anchor"], { cwd: root, env });
  const listed = lampstand(["adopt"], { cwd: root, env });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes("=== principle/stewardship (proposals/principles/stewardship.md)\n---\noccasion"));
  assert.ok(listed.stdout.includes("*Leave the house better than you found it.*"));
  assert.match(listed.stdout, /--- principle\/stewardship: \d+ chars; principle-detail is \d+ of 36000/);
  assert.match(listed.stdout, /--- reflex\/read-first: \d+ chars; reflex-index is \d+ of 10000/);
  assert.ok(!/recommend/i.test(listed.stdout));
  assert.ok(existsSync(join(root, "proposals", "principles", "stewardship.md")));
  assert.deepEqual(readRecord(root), []);
});

test("adopt --ids naming an item that is not proposed is a usage error and adopts nothing", (t) => {
  const root = tempDir(t);
  const env = setup(root);
  lampstand(["propose", "reflex", "drafts/read-first.md", "--occasion", "stale anchor"], { cwd: root, env });
  const result = lampstand(["adopt", "--ids", "reflex/read-first,principle/ghost", "--json"], { cwd: root, env });
  assert.equal(result.status, 64);
  assert.match(envelope(result.stdout).error.message, /no proposed item principle\/ghost/);
  assert.ok(existsSync(join(root, "proposals", "reflexes", "read-first.md")));
});

test("an adopted principle reaches the kernel with origin own", (t) => {
  const root = tempDir(t);
  const env = setup(root);
  lampstand(["propose", "principle", "drafts/stewardship.md", "--occasion", "the house drifted"], { cwd: root, env });
  const result = lampstand(["adopt", "--ids", "principle/stewardship"], { cwd: root, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const text = readFileSync(join(root, "principles", "stewardship.md"), "utf8");
  assert.match(text, /^---\norigin: "own"\noccasion: "the house drifted"\nproposed: "[\d-]+"\nadopted: "[\d-]+"\nadopted-hash: "[0-9a-f]{64}"\n---\n### so : Stewardship/);
  const kernel = readFileSync(join(root, ".house", "generated", "kernel.md"), "utf8");
  assert.ok(kernel.includes("- so Stewardship: Leave the house better than you found it. Failure mode: Polishing what nobody uses."));
});

/**
 * @param {string[]} answers
 * @param {(path: string) => boolean} [edit]
 */
function scripted(answers, edit = () => false) {
  const shown = /** @type {string[]} */ ([]);
  const queue = [...answers];
  return {
    shown,
    talk: {
      show: (/** @type {string} */ text) => void shown.push(text),
      ask: async () => queue.shift() ?? "",
      edit,
    },
  };
}

test("interactive adopt: an empty answer is later, strike records the hash, and a struck text is not proposed again until it changes", async (t) => {
  const root = tempDir(t);
  const env = setup(root);
  lampstand(["propose", "principle", "drafts/stewardship.md", "--occasion", "the house drifted"], { cwd: root, env });
  lampstand(["propose", "reflex", "drafts/read-first.md", "--occasion", "stale anchor"], { cwd: root, env });

  const first = scripted(["", "maybe", "strike"]);
  const acts = await adoptInteractively(root, first.talk, "2026-11-02");
  assert.deepEqual(acts, [
    { id: "principle/stewardship", act: "later" },
    { id: "reflex/read-first", act: "struck" },
  ]);
  assert.ok(first.shown.some((line) => line.includes("answer adopt, edit, strike or later")));
  assert.ok(existsSync(join(root, "proposals", "principles", "stewardship.md")));
  assert.ok(!existsSync(join(root, "proposals", "reflexes", "read-first.md")));
  assert.deepEqual(readRecord(root).map((e) => [e.date, e.act, e.kind, e.slug]), [["2026-11-02", "struck", "reflex", "read-first"]]);

  const again = lampstand(["propose", "reflex", "drafts/read-first.md", "--occasion", "stale anchor again", "--json"], { cwd: root, env });
  assert.equal(again.status, 1);
  assert.match(envelope(again.stdout).refused, /struck as reflex\/read-first on 2026-11-02; it is not proposed again unless its text changes/);

  writeFileSync(join(root, "drafts", "read-first.md"), REFLEX_DRAFT.replace("Read first;", "Always read first;"));
  const changed = lampstand(["propose", "reflex", "drafts/read-first.md", "--occasion", "stale anchor again"], { cwd: root, env });
  assert.equal(changed.status, 0, changed.stdout);
});

test("interactive adopt: edit opens the file and shows it again before the next answer", async (t) => {
  const root = tempDir(t);
  const env = setup(root);
  lampstand(["propose", "reflex", "drafts/read-first.md", "--occasion", "stale anchor"], { cwd: root, env });
  const edited = scripted(["edit", "adopt"], (path) => {
    writeFileSync(path, readFileSync(path, "utf8").replace("Read first;", "Edited: read first;"));
    return true;
  });
  const acts = await adoptInteractively(root, edited.talk, "2026-11-02");
  assert.deepEqual(acts, [{ id: "reflex/read-first", act: "adopted" }]);
  assert.equal(edited.shown.filter((line) => line.startsWith("\n=== reflex/read-first")).length, 2);
  assert.ok(edited.shown[1].includes("Edited: read first;"));
  assert.ok(readFileSync(join(root, "reflexes", "read-first.md"), "utf8").includes("Edited: read first;"));
});

test("propose refuses a name already proposed or adopted", (t) => {
  const root = tempDir(t);
  const env = setup(root);
  assert.equal(lampstand(["propose", "reflex", "drafts/read-first.md", "--occasion", "a"], { cwd: root, env }).status, 0);
  const twice = lampstand(["propose", "reflex", "drafts/read-first.md", "--occasion", "b", "--json"], { cwd: root, env });
  assert.equal(twice.status, 1);
  assert.match(envelope(twice.stdout).refused, /proposals\/reflexes\/read-first\.md is already proposed/);
});

test("propose validates the draft as its kind before filing it", (t) => {
  const root = tempDir(t);
  const env = setup(root);
  plant(root, { "drafts/bad.md": "---\nscope: \"tool:emacs\"\nsummary: \"s\"\n---\n" });
  const result = lampstand(["propose", "reflex", "drafts/bad.md", "--occasion", "x", "--json"], { cwd: root, env });
  assert.equal(result.status, 1);
  assert.equal(envelope(result.stdout).error.code, "E_SCHEMA");
  assert.ok(!existsSync(join(root, "proposals", "reflexes", "bad.md")));
});

test("propose reports every missing or invalid field at once, with the template for the kind", (t) => {
  const root = tempDir(t);
  const env = setup(root);
  plant(root, { "drafts/check-the-trap.md": "Before calling a plumber, check the trap.\n" });
  const bare = lampstand(["propose", "reflex", "drafts/check-the-trap.md", "--occasion", "a blocked sink", "--json"], { cwd: root, env });
  assert.equal(bare.status, 1);
  const message = envelope(bare.stdout).message;
  assert.match(message, /the draft is not a reflex lampstand can adopt \(4 problems\):/);
  assert.match(message, /- a reflex draft must open with a frontmatter block/);
  assert.match(message, /- frontmatter is missing `scope`, `summary`/);
  assert.match(message, /- reflex check-the-trap carries no falsified-when trigger/);
  assert.match(message, /- reflex check-the-trap carries no revise step/);
  assert.match(message, /A reflex draft looks like this .*\n {4}---\n {4}scope: behavioral\n {4}summary: /);
  assert.ok(!existsSync(join(root, "proposals", "reflexes", "check-the-trap.md")));

  plant(root, { "drafts/half.md": '---\nscope: "tool:emacs"\nsummary: "x"\ntitle: "T"\n---\nBody\n' });
  const half = envelope(lampstand(["propose", "reflex", "drafts/half.md", "--occasion", "y", "--json"], { cwd: root, env }).stdout).message;
  assert.match(half, /\(4 problems\)/);
  assert.match(half, /- frontmatter key `title` is not one a reflex carries \(scope, summary, falsified-when, revise\)/);
  assert.match(half, /- scope must match/);

  plant(root, { "drafts/thrift.md": "### th : Thrift\n\nSpend less.\n" });
  const principle = envelope(lampstand(["propose", "principle", "drafts/thrift.md", "--occasion", "z", "--json"], { cwd: root, env }).stdout).message;
  assert.match(principle, /must open with an italic thesis paragraph/);
  assert.match(principle, /must list its facets as/);
  assert.match(principle, /needs a `\*Failure mode:\*` \(or `\*Vice:\*`\) paragraph/);
});

test("a reflex the compiler would reject is refused at propose: the draft owes falsified-when and revise", (t) => {
  const root = tempDir(t);
  const env = setup(root);
  plant(root, { "drafts/x.md": "---\nscope: behavioral\nsummary: x\n---\nx\n" });
  const result = lampstand(["propose", "reflex", "drafts/x.md", "--occasion", "y", "--json"], { cwd: root, env });
  assert.equal(result.status, 1);
  assert.match(envelope(result.stdout).error.message, /carries no falsified-when trigger[\s\S]*carries no revise step/);
});

test("every template the propose help shows passes every check propose applies", () => {
  for (const kind of /** @type {const} */ (["principle", "provision", "reflex"])) {
    assert.deepEqual(draftProblems(kind, PROPOSAL_EXAMPLES[kind].text, `/h/proposals/${kind}s/${PROPOSAL_EXAMPLES[kind].file}`), [], kind);
  }
});
