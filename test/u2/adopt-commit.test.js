// @ts-check
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { adoptItem, listProposals, propose, readRecord } from "../../core/lib/constitution/curate.js";
import { PROPOSAL_EXAMPLES } from "../../core/lib/constitution/examples.js";
import { runCompile } from "../../core/lib/constitution/run.js";
import { adoptInteractively, settleActs } from "../../core/lib/constitution/verbs.js";
import { commitNames, envelope, gitEnv, git, lampstand, plant, plantHouse, tempDir } from "./helpers.js";

const REFLEX_DRAFT = '---\nscope: "tool:omp"\nsummary: "Read the file before editing it"\nfalsified-when: "edits land clean without reading"\nrevise: "narrow it to large files"\n---\nRead first; the anchor must be fresh.\n';
const PRINCIPLE_DRAFT = "### so : Stewardship\n\n*Leave the house better than you found it.*\n\n- **practical**: tidy what you touch.\n\n*Failure mode:* Polishing what nobody uses.\n";

/**
 * A house in a git repository with one seed commit, and two drafts kept outside it.
 * @param {import("./helpers.js").TestContext} t
 * @param {boolean} [identity]
 */
function setup(t, identity = true) {
  const dir = tempDir(t);
  const root = join(dir, "house");
  plantHouse(root);
  plant(dir, { "drafts/read-first.md": REFLEX_DRAFT, "drafts/stewardship.md": PRINCIPLE_DRAFT, "drafts/commit-as-it-lands.draft.md": "# Commit\n\nCommit as it lands.\n" });
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed"]);
  return { dir, root, env: gitEnv(dir, identity), run: (/** @type {string[]} */ args) => lampstand(args, { cwd: root, env: gitEnv(dir, identity) }) };
}

/** @param {ReturnType<typeof setup>} s @param {string} kind @param {string} draft @param {string} occasion */
function proposeAndCommit(s, kind, draft, occasion) {
  const result = s.run(["propose", kind, join(s.dir, "drafts", draft), "--occasion", occasion]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  git(s.root, ["add", "-A"]);
  git(s.root, ["commit", "-q", "-m", `propose ${draft}`]);
}

test("adopt --ids commits exactly the paths the run wrote, and leaves the user's own staged and unstaged work alone", (t) => {
  const s = setup(t);
  proposeAndCommit(s, "reflex", "read-first.md", "a stale anchor");
  writeFileSync(join(s.root, "staged.txt"), "mine\n");
  git(s.root, ["add", "staged.txt"]);
  writeFileSync(join(s.root, "notes.txt"), "mine too\n");
  const before = git(s.root, ["rev-parse", "HEAD"]).trim();

  const result = s.run(["adopt", "--ids", "reflex/read-first", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = envelope(result.stdout);
  const head = git(s.root, ["rev-parse", "HEAD"]).trim();
  assert.notEqual(head, before);
  assert.equal(value.commit, head);
  assert.equal(value.uncommitted, null);
  assert.equal(git(s.root, ["log", "-1", "--format=%s"]).trim(), "Adopt reflex/read-first");

  const names = commitNames(s.root);
  for (const path of ["charter/record.md", "proposals/reflexes/read-first.md", "reflexes/read-first.md"]) assert.ok(names.includes(path), `${path} is in the commit`);
  assert.ok(names.filter((name) => name.startsWith(".house/generated/")).length > 0, "the recompiled projections are in the commit");
  assert.deepEqual(names.filter((name) => !name.startsWith(".house/generated/") && !["charter/record.md", "proposals/reflexes/read-first.md", "reflexes/read-first.md"].includes(name)), []);
  assert.equal(git(s.root, ["status", "--porcelain"]).split("\n").filter(Boolean).sort().join("|"), "?? notes.txt|A  staged.txt");
});

test("a struck item is committed as Strike, and items left for later commit nothing", async (t) => {
  const s = setup(t);
  proposeAndCommit(s, "principle", "stewardship.md", "the house drifted");
  proposeAndCommit(s, "reflex", "read-first.md", "a stale anchor");
  /** @param {string[]} answers */
  const talk = (answers) => ({ show: () => {}, ask: async () => answers.shift() ?? "", edit: () => false });

  const items = listProposals(s.root);
  const later = await adoptInteractively(s.root, talk(["", ""]), "2026-11-02");
  assert.equal(settleActs(s.root, items, later, s.env).commit, null, "nothing was done, so nothing is committed");

  const acts = await adoptInteractively(s.root, talk(["strike", ""]), "2026-11-02");
  const settled = settleActs(s.root, items, acts, s.env);
  assert.equal(settled.message, "Strike principle/stewardship");
  assert.equal(settled.commit?.status, "committed");
  assert.deepEqual(commitNames(s.root), ["charter/record.md", "proposals/principles/stewardship.md"]);
  assert.ok(existsSync(join(s.root, "proposals", "reflexes", "read-first.md")), "the item left for later stays proposed");
});

test("adopt with no git identity still adopts, leaves the files uncommitted, and says how to commit them", (t) => {
  const s = setup(t, false);
  git(s.root, ["config", "user.useConfigOnly", "true"]);
  const proposed = lampstand(["propose", "reflex", join(s.dir, "drafts", "read-first.md"), "--occasion", "a stale anchor"], { cwd: s.root, env: s.env });
  assert.equal(proposed.status, 0, proposed.stdout + proposed.stderr);
  git(s.root, ["add", "-A"]);
  git(s.root, ["commit", "-q", "-m", "propose"]);
  const before = git(s.root, ["rev-parse", "HEAD"]).trim();

  const result = s.run(["adopt", "--ids", "reflex/read-first", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = envelope(result.stdout);
  assert.equal(value.commit, null);
  assert.match(value.uncommitted.reason, /user\.name/);
  assert.match(value.uncommitted.command, /^git add -- .*charter\/record\.md.* && git commit --only -m "Adopt reflex\/read-first" -- /);
  assert.equal(git(s.root, ["rev-parse", "HEAD"]).trim(), before);
  assert.deepEqual(readRecord(s.root).map((entry) => entry.act), ["adopted"]);
  assert.ok(existsSync(join(s.root, "reflexes", "read-first.md")));
});

test("propose refuses a bad file name before writing anything, and names the valid one", (t) => {
  const s = setup(t);
  const result = s.run(["propose", "provision", join(s.dir, "drafts", "commit-as-it-lands.draft.md"), "--occasion", "x", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(envelope(result.stdout).error.message, /try commit-as-it-lands\.md/);
  assert.ok(!existsSync(join(s.root, "proposals")), "no folder or file was created");
});

test("the example files shown by propose --help are accepted by propose, adopt and the compiler", (t) => {
  const s = setup(t);
  for (const [kind, example] of Object.entries(PROPOSAL_EXAMPLES)) {
    plant(s.dir, { [`examples/${example.file}`]: example.text });
    const filed = propose(s.root, /** @type {"principle" | "provision" | "reflex"} */ (kind), join(s.dir, "examples", example.file), "an occasion", "2026-11-02");
    assert.ok("path" in filed, JSON.stringify(filed));
  }
  for (const item of listProposals(s.root)) assert.equal(adoptItem(s.root, item, "2026-11-02"), null, item.id);
  const run = runCompile(s.root);
  assert.deepEqual(run.errors, []);

  const one = s.run(["propose", "provision", "--help"]);
  assert.equal(one.status, 0, one.stderr);
  assert.ok(one.stdout.includes(PROPOSAL_EXAMPLES.provision.text.trimEnd().split("\n")[0]));
  assert.ok(!one.stdout.includes("### so : Stewardship"), "only the named kind's example is shown");
  const all = s.run(["propose", "--help"]).stdout;
  for (const example of Object.values(PROPOSAL_EXAMPLES)) assert.ok(all.includes(example.text.trimEnd().split("\n")[0]));
});

test("from an agent's shell (LAMPSTAND_AGENT set) adopt --ids refuses principles and provisions and still adopts a reflex; without it a provision adopts", (t) => {
  const s = setup(t);
  proposeAndCommit(s, "reflex", "read-first.md", "a stale anchor");
  proposeAndCommit(s, "principle", "stewardship.md", "the house drifted");
  const draft = join(s.dir, "drafts", "commit-as-it-lands.md");
  writeFileSync(draft, "# Commit as it lands\n\nCommit each piece of work when it is finished.\n");
  proposeAndCommit(s, "provision", "commit-as-it-lands.md", "a batch commit lost work");
  const agent = { ...s.env, LAMPSTAND_AGENT: "omp" };

  const refused = lampstand(["adopt", "--ids", "provision/commit-as-it-lands", "--json"], { cwd: s.root, env: agent });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  const value = envelope(refused.stdout);
  assert.equal(value.ok, false);
  assert.equal(value.acts[0].code, "E_OPERATOR_ONLY");
  assert.equal(value.acts[0].refused, "provision/commit-as-it-lands waits for the operator: principles and provisions are adopted by the operator, in a terminal or with /lampstand adopt");
  assert.ok(existsSync(join(s.root, "proposals", "provisions", "commit-as-it-lands.md")), "the proposal stays in place");
  assert.ok(!existsSync(join(s.root, "charter", "provisions", "commit-as-it-lands.md")));
  assert.deepEqual(readRecord(s.root), []);

  // One run: the refused items do not stop the reflex beside them.
  const mixed = lampstand(["adopt", "--ids", "principle/stewardship,reflex/read-first"], { cwd: s.root, env: agent });
  assert.equal(mixed.status, 1, mixed.stdout + mixed.stderr);
  assert.match(mixed.stdout, /E_OPERATOR_ONLY: principle\/stewardship waits for the operator/);
  assert.match(mixed.stdout, /adopted reflex\/read-first/);
  assert.ok(existsSync(join(s.root, "proposals", "principles", "stewardship.md")));
  assert.deepEqual(readRecord(s.root).map((entry) => `${entry.kind}/${entry.slug}`), ["reflex/read-first"]);

  const operator = lampstand(["adopt", "--ids", "provision/commit-as-it-lands"], { cwd: s.root, env: s.env });
  assert.equal(operator.status, 0, operator.stdout + operator.stderr);
  assert.ok(existsSync(join(s.root, "charter", "provisions", "commit-as-it-lands.md")));
});

test("propose finalizes a draft already written at its destination, and still refuses one that carries an occasion", (t) => {
  const s = setup(t);
  plant(s.root, { "proposals/provisions/test-with-every-bugfix.md": "# Test with every bugfix\n\nA fix lands with the test that failed before it.\n" });
  const inPlace = "proposals/provisions/test-with-every-bugfix.md";
  const first = s.run(["propose", "provision", inPlace, "--occasion", "a fix shipped untested", "--json"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(envelope(first.stdout).path, inPlace);
  const text = readFileSync(join(s.root, inPlace), "utf8");
  assert.match(text, /^---\noccasion: "a fix shipped untested"\nproposed: "\d{4}-\d{2}-\d{2}"\n---\n# Test with every bugfix\n/);
  assert.equal(listProposals(s.root).length, 1);

  const again = s.run(["propose", "provision", inPlace, "--occasion", "another", "--json"]);
  assert.equal(again.status, 1);
  assert.match(envelope(again.stdout).refused, /already proposed/);
  assert.equal(readFileSync(join(s.root, inPlace), "utf8"), text, "the filed proposal is untouched");
});
