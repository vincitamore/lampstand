// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { SLOW, envelope, fakeAgora, lampstand, plantHouse, read, roomsEnv, tempDir } from "./helpers.js";

test("rooms enable commits what it seeded and proposed, and not the house.toml edit the operator made by hand", SLOW, async (t) => {
  const dir = tempDir(t);
  const base = roomsEnv(dir);
  const env = {
    ...base,
    // The fake agora first, then the real PATH so git is found.
    PATH: `${base.PATH}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(dir, "no-such-gitconfig"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const root = plantHouse(dir, env);
  fakeAgora(dir, "0.2.5");
  writeFileSync(join(root, "house.toml"), read(root, "house.toml").toString("utf8").replace("rooms = false", "rooms = true"));
  /** @param {string[]} args */
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout;

  const result = await lampstand(["rooms", "enable", "--yes", "--json"], { env, cwd: root });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = envelope(result.stdout);
  assert.equal(out.commit, git(["rev-parse", "HEAD"]).trim());
  assert.equal(git(["log", "-1", "--format=%s"]).trim(), "Enable rooms");
  const names = git(["show", "--name-only", "--no-renames", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
  // Turning the module on does not change what is projected, so no projection is rewritten or committed.
  assert.deepEqual(names, [
    ".house/planted.json",
    "proposals/provisions/room-messages.md",
    "rooms/README.md",
    "rooms/example-room.json",
  ]);
  assert.equal(git(["status", "--porcelain"]).trim(), "M house.toml");
});
