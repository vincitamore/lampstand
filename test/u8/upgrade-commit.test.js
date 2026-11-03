// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitNames, gitEnv } from "../u2/helpers.js";
import { answersToml, copyPackage, envelope, lampstand, read, SLOW, tempDir } from "./helpers.js";

/** @param {import("./helpers.js").TestContext} t @param {boolean} identity */
function setup(t, identity) {
  const dir = tempDir(t);
  const house = join(dir, "house");
  const env = gitEnv(dir, identity);
  writeFileSync(join(dir, "answers.toml"), answersToml());
  const planted = lampstand(["init", "house", "--answers", "answers.toml"], { cwd: dir, env: gitEnv(dir, true), entryDir: dir });
  assert.equal(planted.status, 0, planted.stdout + planted.stderr);
  const pkg = copyPackage(join(dir, "pkg"));
  const run = (/** @type {string[]} */ args) => lampstand(args, { cwd: house, env, pkg, entryDir: dir });
  const git = (/** @type {string[]} */ args) => spawnSync("git", args, { cwd: house, env: gitEnv(dir, true), encoding: "utf8" }).stdout;
  return { house, pkg, run, git };
}

test("upgrade commits what it replaced, proposed and re-recorded, and not an edited file it left alone", SLOW, (t) => {
  const s = setup(t, true);
  appendFileSync(join(s.pkg, "templates", "constitution", "curation.md"), "\nA newer curation line.\n");
  appendFileSync(join(s.pkg, "templates", "constitution", "charter", "core.rules.md"), "- A provision names the gate that checks it.\n");
  appendFileSync(join(s.house, "charter", "core.md"), "\nOur own rule about Fridays.\n");
  writeFileSync(join(s.house, "notes.txt"), "mine\n");
  const edited = read(s.house, "charter/core.md");

  const result = s.run(["upgrade", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const data = envelope(result.stdout);
  const head = s.git(["rev-parse", "HEAD"]).trim();
  assert.equal(data.commit, head);
  assert.equal(data.uncommitted, null);
  assert.match(s.git(["log", "-1", "--format=%s"]).trim(), /^Upgrade the house to lampstand \d+\.\d+\.\d+/);
  assert.deepEqual(commitNames(s.house, "HEAD").filter((name) => !name.startsWith(".house/generated/")), [
    ".house/planted.json",
    "AGENTS.md",
    "curation.md",
    "proposals/updates/charter/core.md",
  ]);
  assert.equal(read(s.house, "charter/core.md"), edited);
  assert.equal(s.git(["status", "--porcelain"]).split("\n").filter(Boolean).sort().join("|"), " M charter/core.md|?? notes.txt");

  const again = envelope(s.run(["upgrade", "--json"]).stdout);
  assert.equal(again.commit, null, "an upgrade that changes nothing commits nothing");
  assert.equal(s.git(["rev-parse", "HEAD"]).trim(), head);
});

test("upgrade with no git identity still upgrades, leaves it uncommitted, and gives the command", SLOW, (t) => {
  const s = setup(t, false);
  appendFileSync(join(s.pkg, "templates", "constitution", "curation.md"), "\nA newer curation line.\n");
  const before = s.git(["rev-parse", "HEAD"]).trim();
  const result = s.run(["upgrade", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const data = envelope(result.stdout);
  assert.equal(data.commit, null);
  assert.match(data.uncommitted.reason, /user\.name/);
  assert.match(data.uncommitted.command, /^git add -- .*curation\.md.* && git commit --only -m "Upgrade the house to lampstand /);
  assert.equal(s.git(["rev-parse", "HEAD"]).trim(), before);
  assert.match(read(s.house, "curation.md"), /A newer curation line\./);
});

test("a house whose projections carry an input hash from an older definition is fresh again after upgrade", SLOW, (t) => {
  const s = setup(t, true);
  const dir = join(s.house, ".house", "generated");
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    writeFileSync(file, readFileSync(file, "utf8").replace(/input-hash([": ]+)[0-9a-f]{64}/, `input-hash$1${"0".repeat(64)}`));
  }
  assert.equal(s.run(["compile", "--check"]).status, 1, "the old hash reads as stale");
  const result = s.run(["upgrade", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(s.run(["compile", "--check"]).status, 0);
  assert.ok(commitNames(s.house).some((name) => name.startsWith(".house/generated/")), "the refreshed projections are committed");
});
