// @ts-check
// The real OS scheduler is never touched: each platform runs against a recording fake that keeps just enough state
// (which tasks exist, which timers are enabled, the crontab) for probes to answer as the real tool would.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadHouse } from "../../core/lib/governance/jobs.js";
import { tickKey } from "../../core/lib/scheduler/os.js";
import { readSeat } from "../../core/lib/seat/ledger.js";
import { disableScheduler, enableScheduler, schedulerStatus } from "../../core/lib/scheduler/verbs.js";
import { BIN, HOUSE_ID, HOUSE_TOML, isolatedEnv, plant } from "../u1/helpers.js";
import { envelope, lampstand, tempDir } from "./helpers.js";

/** @typedef {import("../../core/lib/scheduler/os.js").Host} Host */
/** @typedef {import("../../core/lib/scheduler/os.js").CommandResult} CommandResult */

const OK = { status: 0, stdout: "", stderr: "" };

/**
 * @param {import("node:test").TestContext} t
 * @param {NodeJS.Platform} platform
 * @param {(argv: string[], input: string | undefined) => CommandResult} answer
 */
function setup(t, platform, answer) {
  const dir = tempDir(t);
  const root = join(dir, "house");
  plant(root, { "house.toml": `${HOUSE_TOML}[modules]\nscheduler = true\n` });
  const env = { ...isolatedEnv(dir), XDG_CONFIG_HOME: join(dir, "xdg") };
  /** @type {string[][]} */
  const calls = [];
  /** @type {Host} */
  const host = {
    platform,
    home: join(dir, "home"),
    uid: 501,
    env,
    scratch: join(dir, "scratch"),
    run(command, args, options = {}) {
      calls.push([command, ...args]);
      return answer([command, ...args], options.input);
    },
  };
  const house = loadHouse(root);
  /** @type {string[]} */
  const asked = [];
  /** @param {string} question */
  const yes = (question) => {
    asked.push(question);
    return true;
  };
  return { root, house, host, calls, asked, yes, key: tickKey(root, HOUSE_ID), seat: () => readSeat(env).entries };
}

const tick = (/** @type {string} */ root) => [process.execPath, BIN, "tick", "--house", root];

test("windows: a per-user Task Scheduler task is created with schtasks and deleted again", async (t) => {
  /** @type {Set<string>} */
  const tasks = new Set();
  const s = setup(t, "win32", ([, verb, , name]) => {
    if (verb === "/Query") return tasks.has(name) ? { status: 0, stdout: "<Task/>", stderr: "" } : { status: 1, stdout: "", stderr: "ERROR: not found" };
    if (verb === "/Create") tasks.add(name);
    if (verb === "/Delete") tasks.delete(name);
    return OK;
  });
  const command = `"${process.execPath}" "${BIN}" tick --house "${s.root}"`;
  const enabled = await enableScheduler({ house: s.house, host: s.host, confirm: s.yes });
  assert.equal(enabled.ok ?? true, true, enabled.text);
  assert.deepEqual(s.calls, [
    ["schtasks", "/Query", "/TN", s.key, "/XML"],
    ["schtasks", "/Create", "/TN", s.key, "/TR", command, "/SC", "MINUTE", "/MO", "15", "/F"],
  ]);
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0], new RegExp(`Task Scheduler task "${s.key}" for the current user, every 15 minutes`));
  assert.deepEqual(s.seat().map((entry) => [entry.kind, entry.target, entry.before]), [["schtasks", s.key, null]]);
  assert.deepEqual(schedulerStatus({ house: s.house, host: s.host }).data?.registered, true);

  s.calls.length = 0;
  disableScheduler({ house: s.house, host: s.host });
  assert.deepEqual(s.calls, [
    ["schtasks", "/Query", "/TN", s.key],
    ["schtasks", "/Delete", "/TN", s.key, "/F"],
  ]);
  assert.deepEqual(s.seat(), []);
  assert.equal(tasks.size, 0);
});

test("windows: a task that existed before enable is restored from its recorded definition on disable", async (t) => {
  /** @type {string[] | null} */
  let restored = null;
  const s = setup(t, "win32", (argv) => {
    if (argv[1] === "/Query") return { status: 0, stdout: "<Task>earlier</Task>", stderr: "" };
    if (argv[1] === "/Create" && argv[4] === "/XML") restored = [argv[5], readFileSync(argv[5], "utf8")];
    return OK;
  });
  await enableScheduler({ house: s.house, host: s.host, confirm: s.yes });
  s.calls.length = 0;
  disableScheduler({ house: s.house, host: s.host });
  const xml = join(s.host.scratch, `${s.key}.xml`);
  assert.deepEqual(s.calls, [
    ["schtasks", "/Query", "/TN", s.key],
    ["schtasks", "/Create", "/TN", s.key, "/XML", xml, "/F"],
  ]);
  assert.deepEqual(restored, [xml, "<Task>earlier</Task>"]);
  assert.equal(existsSync(xml), false, "the temporary definition file is removed");
});

test("linux: a systemd user service and timer are written and enabled, then disabled and removed", async (t) => {
  /** @type {Set<string>} */
  const enabled = new Set();
  const s = setup(t, "linux", ([command, , verb, ...rest]) => {
    if (command !== "systemctl") return { status: 127, stdout: "", stderr: "unexpected" };
    if (verb === "is-enabled") return enabled.has(rest[0]) ? { status: 0, stdout: "enabled\n", stderr: "" } : { status: 1, stdout: "disabled\n", stderr: "" };
    if (verb === "enable") enabled.add(rest[1]);
    if (verb === "disable") enabled.delete(rest[1]);
    return OK;
  });
  const timer = `${s.key}.timer`;
  const units = join(s.host.env.XDG_CONFIG_HOME ?? "", "systemd", "user");
  await enableScheduler({ house: s.house, host: s.host, confirm: s.yes });
  assert.deepEqual(s.calls, [
    ["systemctl", "--user", "show-environment"],
    ["systemctl", "--user", "is-enabled", timer],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", timer],
  ]);
  const service = readFileSync(join(units, `${s.key}.service`), "utf8");
  assert.ok(service.includes(`ExecStart=${tick(s.root).map((word) => `"${word.replace(/\\/g, "\\\\")}"`).join(" ")}\n`), service);
  assert.match(readFileSync(join(units, timer), "utf8"), /\nOnCalendar=\*:0\/15\nPersistent=true\n/);
  for (const path of [join(units, `${s.key}.service`), join(units, timer)]) assert.match(s.asked[0], new RegExp(`file ${path.replace(/[\\.]/g, "\\$&")}`));
  assert.deepEqual(s.seat().map((entry) => [entry.kind, entry.before]), [["file", null], ["file", null], ["systemd-timer", null]]);

  s.calls.length = 0;
  disableScheduler({ house: s.house, host: s.host });
  assert.deepEqual(s.calls, [
    ["systemctl", "--user", "is-enabled", timer],
    ["systemctl", "--user", "disable", "--now", timer],
    ["systemctl", "--user", "daemon-reload"],
  ]);
  assert.equal(existsSync(join(units, timer)), false);
  assert.equal(existsSync(join(units, `${s.key}.service`)), false);
  assert.deepEqual(s.seat(), []);
});

test("linux without systemctl --user: a crontab line is added and removed, leaving the user's crontab as it was", async (t) => {
  const before = "MAILTO=me@example.invalid\n0 1 * * * /usr/local/bin/backup\n";
  /** @type {string | null} */
  let crontab = before;
  /** @type {(string | undefined)[]} */
  const inputs = [];
  const s = setup(t, "linux", ([command, flag], input) => {
    if (command === "systemctl") return { status: 1, stdout: "", stderr: "Failed to connect to bus" };
    if (flag === "-l") return crontab === null ? { status: 1, stdout: "", stderr: "no crontab for u4" } : { status: 0, stdout: crontab, stderr: "" };
    if (flag === "-") {
      inputs.push(input);
      crontab = input ?? "";
    }
    if (flag === "-r") crontab = null;
    return OK;
  });
  const line = `*/15 * * * * ${tick(s.root).map((word) => `'${word}'`).join(" ")} # ${s.key}`;
  await enableScheduler({ house: s.house, host: s.host, confirm: s.yes });
  assert.deepEqual(s.calls, [
    ["systemctl", "--user", "show-environment"],
    ["crontab", "-l"],
    ["crontab", "-"],
  ]);
  assert.equal(crontab, `${before}${line}\n`);
  assert.match(s.asked[0], /crontab line \(systemctl --user is unavailable\)/);
  assert.deepEqual(s.seat().map((entry) => [entry.kind, entry.before, entry.line]), [["crontab", before, line]]);

  s.calls.length = 0;
  disableScheduler({ house: s.house, host: s.host });
  assert.deepEqual(s.calls, [
    ["crontab", "-l"],
    ["crontab", "-"],
  ]);
  assert.equal(crontab, before);
});

test("linux crontab: a user with no crontab before has none after disable", async (t) => {
  /** @type {string | null} */
  let crontab = null;
  const s = setup(t, "linux", ([command, flag], input) => {
    if (command === "systemctl") return { status: 1, stdout: "", stderr: "" };
    if (flag === "-l") return crontab === null ? { status: 1, stdout: "", stderr: "no crontab for u4" } : { status: 0, stdout: crontab, stderr: "" };
    if (flag === "-") crontab = input ?? "";
    if (flag === "-r") crontab = null;
    return OK;
  });
  await enableScheduler({ house: s.house, host: s.host, confirm: s.yes });
  s.calls.length = 0;
  disableScheduler({ house: s.house, host: s.host });
  assert.deepEqual(s.calls, [
    ["crontab", "-l"],
    ["crontab", "-r"],
  ]);
  assert.equal(crontab, null);
});

test("macos: a launchd agent plist is written and bootstrapped into gui/<uid>, then booted out and removed", async (t) => {
  /** @type {Set<string>} */
  const loaded = new Set();
  const s = setup(t, "darwin", ([command, verb, target, plist]) => {
    if (command !== "launchctl") return { status: 127, stdout: "", stderr: "unexpected" };
    if (verb === "print") return loaded.has(target) ? OK : { status: 113, stdout: "", stderr: "Could not find service" };
    if (verb === "bootstrap") loaded.add(`${target}/${plist.split(/[\\/]/).pop()?.replace(/\.plist$/, "")}`);
    if (verb === "bootout") loaded.delete(target);
    return OK;
  });
  const label = `dev.lampstand.${s.key}`;
  const service = `gui/501/${label}`;
  const plist = join(s.host.home, "Library", "LaunchAgents", `${label}.plist`);
  await enableScheduler({ house: s.house, host: s.host, confirm: s.yes });
  assert.deepEqual(s.calls, [
    ["launchctl", "print", service],
    ["launchctl", "bootstrap", "gui/501", plist],
  ]);
  const text = readFileSync(plist, "utf8");
  assert.ok(text.includes(tick(s.root).map((word) => `    <string>${word}</string>`).join("\n")), text);
  assert.match(text, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.equal(loaded.has(service), true);

  s.calls.length = 0;
  disableScheduler({ house: s.house, host: s.host });
  assert.deepEqual(s.calls, [
    ["launchctl", "print", service],
    ["launchctl", "bootout", service],
  ]);
  assert.equal(existsSync(plist), false);
  assert.deepEqual(s.seat(), []);
});

test("enable asks once and creates nothing when declined; enabling twice does not ask again", async (t) => {
  const s = setup(t, "win32", ([, verb]) => (verb === "/Query" ? { status: 1, stdout: "", stderr: "" } : OK));
  const declined = await enableScheduler({ house: s.house, host: s.host, confirm: () => false });
  assert.equal(declined.exit, 1);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.seat(), []);

  await enableScheduler({ house: s.house, host: s.host, confirm: s.yes });
  const again = await enableScheduler({ house: s.house, host: s.host, confirm: s.yes });
  assert.equal(again.data?.changed, false);
  assert.equal(s.asked.length, 1);
  assert.equal(s.calls.filter((call) => call[1] === "/Create").length, 1);
});

test("lampstand scheduler enable refuses while the scheduler module is off, before touching the OS", (t) => {
  const dir = tempDir(t);
  const root = join(dir, "house");
  plant(root, { "house.toml": HOUSE_TOML });
  const result = lampstand(["scheduler", "enable", "--yes", "--json"], { cwd: root, env: isolatedEnv(dir) });
  assert.equal(result.status, 1);
  const out = envelope(result.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.enabled, false);
  assert.equal(existsSync(join(dir, "config-root", "lampstand", "seat.json")), false);
});

test("scheduler enable and disable are the operator's: refused from an agent's shell before anything is touched, status still answers", (t) => {
  const dir = tempDir(t);
  const root = join(dir, "house");
  plant(root, { "house.toml": `${HOUSE_TOML}[modules]\nscheduler = true\n` });
  const agent = { ...isolatedEnv(dir), LAMPSTAND_AGENT: "omp" };
  for (const verb of ["enable", "disable"]) {
    const result = lampstand(["scheduler", verb, ...(verb === "enable" ? ["--yes"] : []), "--json"], { cwd: root, env: agent });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const out = envelope(result.stdout);
    assert.equal(out.error.code, "E_OPERATOR_ONLY");
    assert.match(out.error.message, new RegExp(`^lampstand scheduler ${verb} waits for the operator: .*in a terminal`));
  }
  assert.equal(existsSync(join(dir, "config-root", "lampstand", "seat.json")), false, "nothing was recorded");
  assert.equal(lampstand(["scheduler", "status", "--json"], { cwd: root, env: agent }).status, 0, "reading is not refused");
});
