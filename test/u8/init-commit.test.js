// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitNames, gitEnv } from "../u2/helpers.js";
import { answersToml, envelope, lampstand, SLOW, tempDir } from "./helpers.js";

/** @param {string} cwd @param {NodeJS.ProcessEnv} env @param {string[]} args */
function git(cwd, env, args) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** @param {import("./helpers.js").TestContext} t @param {boolean} identity */
function setup(t, identity) {
  const dir = tempDir(t);
  writeFileSync(join(dir, "answers.toml"), answersToml());
  const env = gitEnv(dir, identity);
  return { dir, house: join(dir, "house"), env, run: (/** @type {string[]} */ args) => lampstand(args, { cwd: dir, env, entryDir: dir }) };
}

test("init commits exactly what it planted as Plant the house, in a repository it created", SLOW, (t) => {
  const s = setup(t, true);
  const result = s.run(["init", "house", "--answers", "answers.toml", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = envelope(result.stdout);
  assert.equal(value.git, "initialized");
  assert.equal(value.commit, git(s.house, s.env, ["rev-parse", "HEAD"]).trim());
  assert.equal(git(s.house, s.env, ["log", "--format=%s"]).trim(), "Plant the house");
  assert.equal(git(s.house, s.env, ["status", "--porcelain"]), "", "nothing is left uncommitted");
  const names = commitNames(s.house);
  for (const path of ["house.toml", "AGENTS.md", ".gitattributes", ".gitignore", "projects/README.md", ".house/planted.json", ".house/generated/kernel.md"]) assert.ok(names.includes(path), path);

  const again = envelope(s.run(["init", "house", "--json"]).stdout);
  assert.equal(again.commit, null, "a second init has nothing to commit");
  assert.equal(git(s.house, s.env, ["rev-list", "--count", "HEAD"]).trim(), "1");
});

test("in an existing repository init commits only its own paths: what the user staged or left untracked stays out", SLOW, (t) => {
  const s = setup(t, true);
  mkdirSync(s.house, { recursive: true });
  git(s.house, s.env, ["init", "-q"]);
  writeFileSync(join(s.house, "mine.txt"), "staged\n");
  writeFileSync(join(s.house, "loose.txt"), "untracked\n");
  git(s.house, s.env, ["add", "mine.txt"]);
  const result = s.run(["init", "house", "--answers", "answers.toml", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(envelope(result.stdout).git, "existing");
  assert.ok(!commitNames(s.house).some((name) => name === "mine.txt" || name === "loose.txt"));
  assert.equal(git(s.house, s.env, ["status", "--porcelain"]).split("\n").filter(Boolean).sort().join("|"), "?? loose.txt|A  mine.txt");
});

test("with no git identity init still plants, leaves the files uncommitted, and prints the command that commits them", SLOW, (t) => {
  const s = setup(t, false);
  const result = s.run(["init", "house", "--answers", "answers.toml", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = envelope(result.stdout);
  assert.equal(value.commit, null);
  assert.match(value.uncommitted.reason, /user\.name/);
  assert.equal(value.uncommitted.command, 'git add -A && git commit -m "Plant the house"');
  const text = s.run(["init", "house2", "--answers", "answers.toml"]).stdout;
  assert.match(text, /git: initialized a repository; left uncommitted \(git has no user\.name and user\.email to sign with\); to commit: git add -A && git commit -m "Plant the house"/);
});
