// @ts-check
// The real OS scheduler is never touched: scheduler entries are reversed against a recording fake host.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { userConfigPath } from "../../core/lib/config.js";
import { readSeat, recordSeat } from "../../core/lib/seat/ledger.js";
import { seatEntries, seatReset, setDefaultHouse } from "../../core/lib/seat/seat.js";
import { envelope, isolatedEnv, lampstand, SLOW, tempDir } from "./helpers.js";

/** @typedef {import("../../core/lib/scheduler/os.js").Host} Host */

const KEY = "lampstand-tick-0b9a1c2e-12345678";

test("seat reset reverses newest first: the scheduler's entry through its own revert, then the config key; an unknown kind stays", (t) => {
  const dir = tempDir(t);
  const env = isolatedEnv(dir);
  const house = join(dir, "house");
  setDefaultHouse(env, house);
  recordSeat(env, { id: `scheduler:${KEY}:schtasks:${KEY}`, owner: "scheduler", house, kind: "schtasks", target: KEY, before: null });
  recordSeat(env, { id: "rooms:lobby", owner: "rooms", house, kind: "agora-room", target: "lobby", before: null });
  assert.deepEqual(seatEntries(env).map((entry) => entry.kind), ["agora-room", "schtasks", "user-config"]);

  const tasks = new Set([KEY]);
  /** @type {string[][]} */
  const calls = [];
  /** @type {boolean[]} */
  const configWhenDeleted = [];
  /** @type {Host} */
  const host = {
    platform: "win32",
    home: join(dir, "home"),
    uid: -1,
    env,
    scratch: join(dir, "scratch"),
    run(command, args) {
      calls.push([command, ...args]);
      if (args[0] === "/Query") return tasks.has(args[2]) ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "not found" };
      if (args[0] === "/Delete") {
        tasks.delete(args[2]);
        configWhenDeleted.push(existsSync(userConfigPath(env)));
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };

  const { undone, left } = seatReset(host);
  assert.deepEqual(calls, [
    ["schtasks", "/Query", "/TN", KEY],
    ["schtasks", "/Delete", "/TN", KEY, "/F"],
  ]);
  assert.deepEqual(configWhenDeleted, [true], "the newer scheduler entry is undone before the older config key");
  assert.deepEqual(undone, [`removed Task Scheduler task ${KEY}`, `removed default_house from ${userConfigPath(env)}`]);
  assert.deepEqual(left.map((entry) => entry.id), ["rooms:lobby"]);
  assert.deepEqual(readSeat(env).entries.map((entry) => entry.id), ["rooms:lobby"]);
  assert.ok(!existsSync(userConfigPath(env)));
});

test("recording default_house twice keeps the first before-value, so reset restores what was there before lampstand", (t) => {
  const dir = tempDir(t);
  const env = isolatedEnv(dir);
  setDefaultHouse(env, join(dir, "a"));
  setDefaultHouse(env, join(dir, "b"));
  assert.match(readFileSync(userConfigPath(env), "utf8"), /^default_house = ".*b"\n$/);
  assert.deepEqual(readSeat(env).entries.map((entry) => entry.before), [null]);
  assert.equal(setDefaultHouse(env, join(dir, "b")).changed, false);
});

test("seat reset exits 1 naming an entry it cannot reverse, and leaves it in the ledger", SLOW, (t) => {
  const dir = tempDir(t);
  const env = isolatedEnv(dir);
  recordSeat(env, { id: "rooms:lobby", owner: "rooms", house: join(dir, "house"), kind: "agora-room", target: "lobby", before: null });
  const result = lampstand(["seat", "reset", "--json"], { cwd: dir, env, entryDir: dir });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(envelope(result.stdout).left, [{ id: "rooms:lobby", owner: "rooms", kind: "agora-room", target: "lobby" }]);
  assert.equal(readSeat(env).entries.length, 1);
});
