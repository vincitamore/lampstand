// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { CHECKS } from "../../core/lib/doctor/checks.js";
import { findDoctor } from "../../core/lib/scheduler/tick.js";
import { which } from "../../core/lib/doctor/util.js";
import { REPO } from "../u1/helpers.js";
import { codes, doctor, doctorEnv, plant, plantHouse, SLOW, tempDir } from "./helpers.js";

test("the check list is pinned", () => {
  // Every check here is objective: it reports a state that is wrong, or a fact, on the evidence of files, house.db,
  // PATH or a host's own records, never a judgement about content. Adding, removing or reclassifying one is a
  // deliberate change to this list.
  assert.deepEqual(
    CHECKS.map(({ id, area, quick, codes: declared }) => ({ id, area, quick, codes: declared })),
    [
      { id: "house-marker", area: "core", quick: true, codes: { NO_HOUSE: 3, HOUSE_UNRESOLVED: 3, SETUP_UNFINISHED: 3, HOUSE_ROOT_ELSEWHERE: 0 } },
      { id: "house-toml", area: "core", quick: true, codes: { HOUSE_TOML_INVALID: 2, HOUSE_SCHEMA_NEWER: 2, HOUSE_SCHEMA_OLDER: 1, PLUGIN_TOO_OLD: 2 } },
      { id: "projections", area: "core", quick: true, codes: { CONSTITUTION_INVALID: 2, PROJECTION_MISSING: 1, PROJECTION_STALE: 1, REGION_STALE: 1 } },
      { id: "budgets", area: "core", quick: true, codes: { BUDGET_OVER_ENVELOPE: 2 } },
      { id: "state-db", area: "core", quick: true, codes: { STATE_DB_NEWER: 2, STATE_DB_UNREADABLE: 2 } },
      { id: "state-local", area: "core", quick: true, codes: { STATE_DIR_INVALID: 2, STATE_DIR_NOT_LOCAL: 2 } },
      { id: "jobs", area: "core", quick: true, codes: { JOB_STALE: 1, JOB_NOT_LANDED: 1, JOB_REJECTED: 2 } },
      // Asked of the OS scheduler, a host process, so never part of --quick.
      { id: "tick-entry", area: "core", quick: false, codes: { TICK_ENTRY_MISSING: 1, TICK_ENTRY_ELSEWHERE: 1, SEAT_LEDGER_INVALID: 2 } },
      { id: "runtimes", area: "core", quick: true, codes: { RUNTIME_MISSING: 2, GIT_MISSING: 2 } },
      { id: "proposals", area: "core", quick: true, codes: { PROPOSALS_WAITING: 0 } },
      { id: "omp-version", area: "omp", quick: false, codes: { OMP_TOO_OLD: 2 } },
      { id: "omp-double-load", area: "omp", quick: false, codes: { OMP_DOUBLE_LOAD: 2, OMP_CONFIG_UNREADABLE: 0 } },
      { id: "omp-shadowing", area: "omp", quick: false, codes: { OMP_SHADOWED: 0 } },
      { id: "hermes-enabled", area: "hermes", quick: false, codes: { HERMES_PLUGIN_DISABLED: 3, HERMES_CONFIG_UNREADABLE: 0 } },
      { id: "hermes-node", area: "hermes", quick: false, codes: { HERMES_NODE_MISSING: 2 } },
      { id: "hermes-context", area: "hermes", quick: false, codes: { HERMES_CONTEXT: 0 } },
      { id: "hermes-kernel-budget", area: "hermes", quick: false, codes: { HERMES_KERNEL_SKIPPED: 2 } },
      { id: "agora-version", area: "rooms", quick: false, codes: { AGORA_MISSING: 2, AGORA_TOO_OLD: 2, AGORA_VERSION_UNKNOWN: 2 } },
      { id: "rooms-channels", area: "rooms", quick: false, codes: { ROOM_CHANNEL_SHARED: 2, ROOMS_CONFIG_UNREADABLE: 0 } },
    ],
  );
});

test("--quick runs the core checks only and never gathers host facts", SLOW, (t) => {
  const { env, root } = plantHouse(t);
  plant(join(String(env.HOME), ".omp", "plugins", "node_modules", "lampstand"), { "package.json": '{ "name": "lampstand" }\n' });
  plant(join(String(env.HOME), ".omp", "agent"), { "config.yml": "extensions:\n  - ~/.omp/plugins/node_modules/lampstand/hosts/omp/index.ts\n  - ~/src/lampstand\n" });
  plant(join(String(env.HOME), "src", "lampstand"), { "package.json": '{ "name": "lampstand" }\n' });

  const quick = doctor(env, root, { quick: true });
  assert.equal(quick.facts.hosts, null);
  assert.deepEqual(quick.ran, CHECKS.filter((check) => check.quick).map((check) => check.id));
  assert.deepEqual(codes(quick), []);
  assert.equal(quick.exit, 0);

  const full = doctor(env, root);
  assert.deepEqual(codes(full), ["OMP_DOUBLE_LOAD"]);
  assert.equal(full.exit, 2);
});

/**
 * An entry script registering the doctor verbs beside core/bin/lampstand.js's own, until the entry registers them.
 * @param {string} dir
 */
function entry(dir) {
  const lib = (/** @type {string} */ rel) => JSON.stringify(pathToFileURL(join(REPO, "core", "lib", rel)).href);
  const path = join(dir, "lampstand-entry.mjs");
  writeFileSync(
    path,
    [
      `import { Registry, runCli, versionVerb } from ${lib("cli.js")};`,
      `import { verbs as doctorVerbs } from ${lib("doctor/verbs.js")};`,
      "const registry = new Registry().register(versionVerb, ...doctorVerbs);",
      "process.exitCode = await runCli(registry, process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });",
      "",
    ].join("\n"),
  );
  return path;
}

// The CLI runs under Node, as Hermes spawns it. Under bun it is the node on this process's PATH, resolved here
// because the test's own PATH holds only empty stand-ins.
const NODE = process.versions.bun ? (which("node", process.env) ?? "node") : process.execPath;

/**
 * @param {string} script
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
function cli(script, args, cwd, env) {
  const result = spawnSync(NODE, [script, ...args], { cwd, env, encoding: "utf8", input: "" });
  if (result.error) throw result.error;
  return result;
}

test("lampstand doctor --json: exit 0 in a healthy house, 3 outside any house", SLOW, (t) => {
  const { dir, env, root } = plantHouse(t);
  const script = entry(dir);
  const healthy = cli(script, ["doctor", "--json"], root, env);
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.deepEqual(JSON.parse(healthy.stdout), { ok: true, exit: 0, findings: [] });

  const outside = tempDir(t);
  const none = cli(script, ["doctor", "--json"], outside, doctorEnv(outside));
  assert.equal(none.status, 3, none.stderr);
  const body = JSON.parse(none.stdout);
  assert.deepEqual(Object.keys(body), ["ok", "exit", "findings"]);
  assert.equal(body.ok, false);
  assert.equal(body.exit, 3);
  assert.deepEqual(body.findings.map((/** @type {any} */ finding) => Object.keys(finding)), [["code", "area", "level", "message", "fix"]]);
  assert.equal(body.findings[0].code, "NO_HOUSE");

  const text = cli(script, ["doctor"], outside, doctorEnv(outside));
  assert.equal(text.status, 3);
  assert.match(text.stdout.split("\n")[0], /^error \[NO_HOUSE\] core: /);
});

test("the scheduler's tick finds the doctor verb and runs it --quick against the house it names", SLOW, async (t) => {
  const { env, root } = plantHouse(t);
  const runner = await findDoctor();
  assert.ok(runner);
  assert.deepEqual(await runner({ root, env }), { ok: true, detail: "" });

  rmSync(join(root, ".house", "planted.json"));
  const sick = await runner({ root, env });
  assert.equal(sick.ok, false);
  assert.match(sick.detail, /^error \[SETUP_UNFINISHED\] core: /);
});
