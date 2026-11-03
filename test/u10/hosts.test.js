// @ts-check
// One planted fault per OMP, Hermes and rooms check. Every host location is under the test's temp directory
// (doctorEnv), host binaries are empty stand-ins on PATH, and what they print is the `run` stub's answer.
import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCompile } from "../../core/lib/constitution/run.js";
import { codes, doctor, edit, exe, plant, plantHouse, SLOW } from "./helpers.js";

/** @typedef {import("../../core/lib/doctor/util.js").Runner} Runner */

/** A directory standing in for a lampstand package. @param {string} dir */
function fakeLampstand(dir) {
  plant(dir, { "package.json": '{ "name": "lampstand" }\n', "hosts/omp/index.ts": "" });
  return dir;
}

/**
 * lampstand installed as an OMP plugin in the user's plugin root.
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} enabled
 */
function installOmpPlugin(env, enabled) {
  const plugins = join(String(env.HOME), ".omp", "plugins");
  fakeLampstand(join(plugins, "node_modules", "lampstand"));
  plant(plugins, { "omp-plugins.lock.json": JSON.stringify({ plugins: { lampstand: { version: "0.0.0", enabledFeatures: null, enabled } }, settings: {} }) });
  return join(plugins, "node_modules", "lampstand");
}

/**
 * A runner answering every command with one result, recording what was asked.
 * @param {number | null} status
 * @param {string} stdout
 */
function answering(status, stdout) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {Runner} */
  const run = (file, args) => {
    calls.push([file, ...args]);
    return { status, stdout, stderr: "" };
  };
  return { run, calls };
}

/** @param {{ findings: { code: string }[] }} report @param {string} prefix */
function codesIn(report, prefix) {
  return codes(report).filter((code) => code.startsWith(prefix));
}

test("omp-version: OMP below the adapter's floor, at a newer version, and with no omp to ask", SLOW, (t) => {
  const { dir, env, root } = plantHouse(t);
  installOmpPlugin(env, true);
  writeFileSync(join(dir, "bin", exe("omp")), "");
  const old = answering(0, "omp/0.0.1\n");
  const report = doctor(env, root, { run: old.run });
  assert.deepEqual(codes(report), ["OMP_TOO_OLD"]);
  assert.match(report.findings[0].message, /OMP reports 0\.0\.1; lampstand needs 18\.3\.2 or later/);
  assert.equal(report.exit, 2);
  assert.deepEqual(old.calls, [[join(dir, "bin", exe("omp")), "--version"]]);

  assert.deepEqual(codes(doctor(env, root, { run: answering(0, "omp/999.0.0\n").run })), []);
  rmSync(join(dir, "bin", exe("omp")));
  assert.deepEqual(codes(doctor(env, root)), []);
});

test("omp-double-load: the plugin plus an extensions: entry or an extension folder; a disabled plugin loads once", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  const plugin = installOmpPlugin(env, true);
  const clone = fakeLampstand(join(String(env.HOME), "src", "lampstand"));
  plant(join(String(env.HOME), ".omp", "agent"), { "config.yml": "theme: dark\nextensions:\n  - ~/src/lampstand  # a working copy\n" });
  const double = doctor(env, root);
  assert.deepEqual(codes(double), ["OMP_DOUBLE_LOAD"]);
  assert.ok(double.findings[0].message.includes(plugin) && double.findings[0].message.includes(clone), double.findings[0].message);
  assert.equal(double.exit, 2);

  installOmpPlugin(env, false);
  assert.deepEqual(codes(doctor(env, root)), []);

  fakeLampstand(join(String(env.HOME), ".omp", "agent", "extensions", "lampstand"));
  assert.deepEqual(codes(doctor(env, root)), ["OMP_DOUBLE_LOAD"]);
});

test("omp-double-load: an extensions: block outside lampstand's YAML subset is reported, not guessed", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  installOmpPlugin(env, true);
  plant(join(String(env.HOME), ".omp", "agent"), { "config.yml": "extensions: &paths\n  - ~/src/lampstand\n" });
  const report = doctor(env, root);
  assert.deepEqual(report.findings.map((finding) => [finding.code, finding.level]), [["OMP_CONFIG_UNREADABLE", "info"]]);
  assert.equal(report.exit, 0);
});

test("omp-shadowing: the user's own agent and skill named like the plugin's are information", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  installOmpPlugin(env, true);
  const agentDir = join(String(env.HOME), ".omp", "agent");
  plant(agentDir, { "agents/architect.md": "mine\n", "skills/house/SKILL.md": "mine\n", "agents/unrelated.md": "mine\n" });
  const report = doctor(env, root);
  assert.deepEqual(report.findings.map((finding) => [finding.code, finding.level, finding.message]), [
    ["OMP_SHADOWED", "info", `${join(agentDir, "agents", "architect.md")} shadows the lampstand file of the same name`],
    ["OMP_SHADOWED", "info", `${join(agentDir, "skills", "house")} shadows the lampstand file of the same name`],
  ]);
  assert.equal(report.exit, 0);
});

/**
 * lampstand installed as a Hermes plugin, with `config` as Hermes's config.yaml.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} config
 */
function installHermes(env, config) {
  const home = String(env.HERMES_HOME);
  plant(home, { "plugins/lampstand/plugin.yaml": "manifest_version: 2\nname: lampstand\n", "config.yaml": config });
  return home;
}

test("hermes-enabled: installed but not in plugins.enabled, or in plugins.disabled, is unfinished setup", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  const home = installHermes(env, "model:\n  default: x\nplugins:\n  enabled: []\n");
  const off = doctor(env, root);
  assert.deepEqual(codesIn(off, "HERMES_PLUGIN"), ["HERMES_PLUGIN_DISABLED"]);
  assert.equal(off.exit, 3);

  plant(home, { "config.yaml": "plugins:\n  enabled:\n    - lampstand\n" });
  const on = doctor(env, root);
  assert.deepEqual(codesIn(on, "HERMES_PLUGIN"), []);
  assert.equal(on.exit, 0);

  plant(home, { "config.yaml": "plugins:\n  enabled: [lampstand]\n  disabled: [lampstand]\n" });
  assert.equal(doctor(env, root).exit, 3);

  plant(home, { "config.yaml": "plugins:\n  enabled: &on\n    - lampstand\n" });
  const unreadable = doctor(env, root);
  assert.deepEqual(codesIn(unreadable, "HERMES_CONFIG"), ["HERMES_CONFIG_UNREADABLE"]);
  assert.equal(unreadable.exit, 0);
});

test("hermes-node: no node on PATH or under $HERMES_HOME/node", SLOW, (t) => {
  const { dir, env, root } = plantHouse(t);
  const home = installHermes(env, "plugins:\n  enabled: [lampstand]\n");
  rmSync(join(dir, "bin", exe("node")));
  writeFileSync(join(dir, "bin", exe("bun")), "");
  const missing = doctor(env, root);
  assert.deepEqual(codesIn(missing, "HERMES_NODE"), ["HERMES_NODE_MISSING"]);
  assert.equal(missing.exit, 2);

  plant(home, { [`node/${exe("node")}`]: "" });
  assert.deepEqual(codesIn(doctor(env, root), "HERMES_NODE"), []);
});

test("hermes-context: the AGENTS.md region loads in the house and below it; a .hermes.md shadows it", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  installHermes(env, "plugins:\n  enabled: [lampstand]\n");
  /** @param {string} cwd */
  const context = (cwd) => doctor(env, cwd).findings.filter((finding) => finding.code === "HERMES_CONTEXT").map((finding) => [finding.level, finding.message]);

  assert.deepEqual(context(root), [
    ["info", `Hermes in ${root} loads AGENTS.md: ${join(root, "AGENTS.md")}; the house's AGENTS.md region loads, so the kernel section is a pointer`],
  ]);
  const tasks = join(root, "tasks");
  assert.deepEqual(context(tasks), [
    ["info", `Hermes in ${tasks} loads AGENTS.md: ${join(root, "AGENTS.md")}; the house's AGENTS.md region loads, so the kernel section is a pointer`],
  ]);
  plant(root, { ".hermes.md": "Hermes rules for this repository.\n" });
  assert.deepEqual(context(root), [
    ["info", `Hermes in ${root} loads .hermes.md: ${join(root, ".hermes.md")}; the house's AGENTS.md region does not load, so the kernel section carries K`],
  ]);
});

test("hermes-kernel-budget: the last session skipped the kernel section; a later accepted one clears it", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  const home = installHermes(env, "plugins:\n  enabled: [lampstand]\n");
  plant(home, {
    "logs/agent.log": [
      "2026-01-01 10:00:00 INFO Session plugin prompt section: id=lampstand-kernel plugin=lampstand position=after_memory chars=3700",
      "2026-01-02 10:00:00 WARNING Plugin system prompt section lampstand-kernel (lampstand) exceeded the aggregate session budget (8000 chars) and was skipped",
      "",
    ].join("\n"),
  });
  const skipped = doctor(env, root);
  assert.deepEqual(codesIn(skipped, "HERMES_KERNEL"), ["HERMES_KERNEL_SKIPPED"]);
  assert.equal(skipped.exit, 2);

  appendFileSync(join(home, "logs", "agent.log"), "2026-01-03 10:00:00 INFO Session plugin prompt section: id=lampstand-kernel plugin=lampstand position=after_memory chars=3700\n");
  assert.deepEqual(codesIn(doctor(env, root), "HERMES_KERNEL"), []);
});

/** Turns [modules] rooms on and recompiles, since house.toml is a compiler input. @param {string} root */
function roomsOn(root) {
  edit(root, "house.toml", "rooms = false", "rooms = true");
  runCompile(root);
}

test("agora-version: rooms on without agora, an agora below the floor, one that prints no version", SLOW, (t) => {
  const { dir, env, root } = plantHouse(t);
  roomsOn(root);
  const missing = doctor(env, root);
  assert.deepEqual(codes(missing), ["AGORA_MISSING"]);
  assert.equal(missing.exit, 2);

  writeFileSync(join(dir, "bin", exe("agora")), "");
  const old = doctor(env, root, { run: answering(0, JSON.stringify({ version: "0.2.4" })).run });
  assert.deepEqual(codes(old), ["AGORA_TOO_OLD"]);
  assert.equal(old.exit, 2);

  const silent = doctor(env, root, { run: answering(0, "not json\n").run });
  assert.deepEqual(codes(silent), ["AGORA_VERSION_UNKNOWN"]);
  assert.equal(silent.exit, 2);

  assert.deepEqual(codes(doctor(env, root, { run: answering(0, JSON.stringify({ version: "0.2.5" })).run })), []);
});

test("rooms-channels: a Slack channel that is both an agora room and attached to Hermes", SLOW, (t) => {
  const { dir, env, root } = plantHouse(t);
  roomsOn(root);
  writeFileSync(join(dir, "bin", exe("agora")), "");
  const run = answering(0, JSON.stringify({ version: "0.2.5" })).run;
  const agoraConfig = join(dir, "agora.json");
  writeFileSync(agoraConfig, JSON.stringify({ actor: { name: "a", kind: "agent" }, rooms: { lobby: { transport: "slack", channel: "C0123" }, desk: { transport: "local", path: "x" }, quiet: { transport: "slack", channel: "C0777" } } }));
  const hermes = String(env.HERMES_HOME);
  plant(hermes, { "config.yaml": "slack:\n  allowed_channels:\n    - C0123\n    - C0456\n", ".env": "SLACK_HOME_CHANNEL=C0777\n" });
  const report = doctor({ ...env, AGORA_CONFIG: agoraConfig }, root, { run });
  assert.deepEqual(codes(report), ["ROOM_CHANNEL_SHARED", "ROOM_CHANNEL_SHARED"]);
  assert.match(report.findings[0].message, /^Slack channel C0123 is agora room lobby and is attached to Hermes \(.*slack\.allowed_channels\)/);
  assert.match(report.findings[1].message, /^Slack channel C0777 is agora room quiet and is attached to Hermes \(SLACK_HOME_CHANNEL in .*\.env\)/);
  assert.equal(report.exit, 2);

  plant(hermes, { "config.yaml": 'slack:\n  channel_prompts:\n    "C0123": !!str Research only.\n', ".env": "" });
  const unreadable = doctor({ ...env, AGORA_CONFIG: agoraConfig }, root, { run });
  assert.deepEqual(unreadable.findings.map((finding) => [finding.code, finding.level]), [["ROOMS_CONFIG_UNREADABLE", "info"]]);
  assert.equal(unreadable.exit, 0);
});
