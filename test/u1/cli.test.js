// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Registry, runCli } from "../../core/lib/cli.js";
import { ERROR_CODES, fail } from "../../core/lib/errors.js";
import { BIN, HOUSE_ID, HOUSE_TOML, isolatedEnv, plant, tempDir } from "./helpers.js";

// The CLI runs under Node: that is how Hermes spawns it. Under `bun test` the same file still spawns node when it
// is on PATH.
const NODE = process.versions.bun ? "node" : process.execPath;

/**
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 */
function lampstand(args, options) {
  const result = spawnSync(NODE, [BIN, ...args], { ...options, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** @param {string} stdout */
function envelope(stdout) {
  const lines = stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, `--json must print exactly one line, got ${JSON.stringify(stdout)}`);
  const value = JSON.parse(lines[0]);
  assert.equal(Object.keys(value)[0], "ok", "the first key of a --json envelope is ok");
  return value;
}

test("lampstand root --json inside a house reports walk-up", (t) => {
  const dir = tempDir(t);
  plant(dir, { "house/house.toml": HOUSE_TOML, "house/tasks/.keep": "" });
  const result = lampstand(["root", "--json"], { cwd: join(dir, "house", "tasks"), env: isolatedEnv(dir) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(envelope(result.stdout), { ok: true, rule: "walk-up", root: join(dir, "house"), text: `${join(dir, "house")}\nrule: walk-up` });
});

test("lampstand root --json with HOUSE_ROOT lacking house.toml exits 1 with E_HOUSE_ROOT_INVALID", (t) => {
  const dir = tempDir(t);
  plant(dir, { "house/house.toml": HOUSE_TOML, "empty/.keep": "" });
  const env = { ...isolatedEnv(dir), HOUSE_ROOT: join(dir, "empty") };
  const result = lampstand(["root", "--json"], { cwd: join(dir, "house"), env });
  assert.equal(result.status, 1);
  const value = envelope(result.stdout);
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "E_HOUSE_ROOT_INVALID");
});

test("lampstand root --json with no house is dormant and exits 0", (t) => {
  const dir = tempDir(t);
  const result = lampstand(["root", "--json"], { cwd: dir, env: isolatedEnv(dir) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(envelope(result.stdout), { ok: true, rule: "dormant", root: null, text: `dormant: no house resolved from ${dir}` });
});

test("lampstand root --no-workspace uses default_house; without the flag it stays dormant", (t) => {
  const dir = tempDir(t);
  plant(dir, {
    "home/house.toml": HOUSE_TOML,
    "elsewhere/.keep": "",
    "config-root/lampstand/config.toml": `default_house = '${join(dir, "home")}'\n`,
  });
  const options = { cwd: join(dir, "elsewhere"), env: isolatedEnv(dir) };
  assert.deepEqual(envelope(lampstand(["root", "--json", "--no-workspace"], options).stdout), {
    ok: true,
    rule: "default_house",
    root: join(dir, "home"),
    text: `${join(dir, "home")}\nrule: default_house`,
  });
  assert.equal(envelope(lampstand(["root", "--json"], options).stdout).rule, "dormant");
});

test("lampstand state path prints the state directory without creating it", (t) => {
  const dir = tempDir(t);
  plant(dir, { "house/house.toml": HOUSE_TOML });
  const result = lampstand(["state", "path", "--json"], { cwd: join(dir, "house"), env: isolatedEnv(dir) });
  assert.equal(result.status, 0, result.stderr);
  const value = envelope(result.stdout);
  assert.equal(value.house, join(dir, "house"));
  assert.ok(value.dir.startsWith(join(dir, "state-root", "lampstand", `${HOUSE_ID}-`)), value.dir);
  assert.equal(value.db, join(value.dir, "house.db"));
  assert.equal(value.source, "default");
  assert.equal(existsSync(value.dir), false);

  const text = lampstand(["state", "path"], { cwd: join(dir, "house"), env: isolatedEnv(dir) });
  assert.equal(text.stdout, `${value.dir}\n`);
});

test("lampstand state path with no house exits 1 with E_NO_HOUSE", (t) => {
  const dir = tempDir(t);
  const result = lampstand(["state", "path"], { cwd: dir, env: isolatedEnv(dir) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^lampstand: E_NO_HOUSE: /);
  assert.equal(result.stdout, "");
});

test("lampstand version reports package.json's version", (t) => {
  const dir = tempDir(t);
  const value = envelope(lampstand(["version", "--json"], { cwd: dir, env: isolatedEnv(dir) }).stdout);
  assert.equal(value.ok, true);
  assert.match(value.version, /^\d+\.\d+\.\d+$/);
});

test("usage errors exit 64 with E_USAGE", (t) => {
  const dir = tempDir(t);
  const options = { cwd: dir, env: isolatedEnv(dir) };
  for (const args of [[], ["nope"], ["root", "--bogus"], ["root", "extra"], ["state"], ["version", "--no-workspace"]]) {
    const result = lampstand([...args, "--json"], options);
    assert.equal(result.status, 64, `${args.join(" ")}: ${result.stdout}`);
    assert.equal(envelope(result.stdout).error.code, "E_USAGE");
  }
});

/** An in-memory sink. */
function sink() {
  const chunks = /** @type {string[]} */ ([]);
  return { write: (/** @type {string} */ text) => chunks.push(text), text: () => chunks.join("") };
}

test("dispatch reaches registered verbs, maps error codes to exit codes, and turns bugs into E_INTERNAL", async () => {
  const registry = new Registry().register(
    { name: "probe deep", summary: "s", args: { min: 1, max: 1, usage: "<x>" }, run: ({ args }) => ({ data: { got: args[0] }, text: "" }) },
    { name: "finding", summary: "s", run: () => ({ ok: false, exit: 1, data: { n: 2 }, text: "two findings" }) },
    { name: "broken", summary: "s", run: () => { throw new TypeError("boom"); } },
    { name: "infra", summary: "s", run: () => { throw fail("E_STATE_DIR", "no room"); } },
  );
  /** @param {string[]} argv */
  const call = async (argv) => {
    const stdout = sink();
    const stderr = sink();
    const code = await runCli(registry, argv, { stdout, stderr, env: {}, cwd: "." });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };
  assert.deepEqual(await call(["probe", "deep", "--json", "v"]), { code: 0, stdout: '{"ok":true,"got":"v","text":""}\n', stderr: "" });
  assert.deepEqual(await call(["--json", "probe", "deep", "--", "--json"]), { code: 0, stdout: '{"ok":true,"got":"--json","text":""}\n', stderr: "" });
  assert.deepEqual(await call(["finding", "--json"]), { code: 1, stdout: '{"ok":false,"n":2,"text":"two findings","message":"two findings"}\n', stderr: "" });
  const broken = await call(["broken", "--json"]);
  assert.equal(broken.code, 70);
  assert.equal(JSON.parse(broken.stdout).error.code, "E_INTERNAL");
  assert.match(broken.stderr, /TypeError: boom/);
  const infra = await call(["infra"]);
  assert.equal(infra.code, 2);
  assert.equal(infra.stderr, "lampstand: E_STATE_DIR: no room\n");
});

test("`--` ends the flags: a positional that looks like a flag is taken as written, and a trailing --json is the flag", async () => {
  const registry = new Registry().register({
    name: "probe deep",
    summary: "s",
    args: { min: 1, max: 1, usage: "<x>" },
    run: ({ args, json }) => ({ data: { got: args[0], json }, text: `got ${args[0]}` }),
  });
  /** @param {string[]} argv */
  const call = async (argv) => {
    const stdout = sink();
    const code = await runCli(registry, argv, { stdout, stderr: sink(), env: {}, cwd: "." });
    return { code, stdout: stdout.text() };
  };
  assert.deepEqual(await call(["probe", "deep", "--", "--help"]), { code: 0, stdout: "got --help\n" }, "a title --help is a title, not a help request");
  assert.deepEqual(await call(["probe", "deep", "--", "--"]), { code: 0, stdout: "got --\n" }, "a title -- is a title");
  const appended = await call(["probe", "deep", "--", "--", "--json"]);
  assert.equal(appended.code, 0);
  assert.deepEqual(JSON.parse(appended.stdout), { ok: true, got: "--", json: true, text: "got --" }, "--json appended after free text is the flag");
  assert.equal(JSON.parse((await call(["probe", "deep", "--", "--due=x", "--json"])).stdout).got, "--due=x");
  const usage = await call(["probe", "deep", "--help"]);
  assert.match(usage.stdout, /^usage: lampstand probe deep <x>/);
  assert.match(usage.stdout, /--  end of flags/);
});

test("lampstand --version prints the version; a failure in JSON carries a plain message beside error", (t) => {
  const dir = tempDir(t);
  const options = { cwd: dir, env: isolatedEnv(dir) };
  const plain = lampstand(["--version"], options);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^lampstand \d+\.\d+\.\d+ \(/);
  assert.match(envelope(lampstand(["--json", "-v"], options).stdout).version, /^\d+\.\d+\.\d+$/);
  const failed = envelope(lampstand(["nope", "--json"], options).stdout);
  assert.equal(failed.ok, false);
  assert.equal(typeof failed.message, "string");
  assert.equal(failed.message, failed.error.message);
});

test("a verb name or global flag cannot be registered twice", () => {
  const verb = { name: "x", summary: "s", run: () => ({ text: "" }) };
  assert.throws(() => new Registry().register(verb, verb), /registered twice/);
  assert.throws(
    () => new Registry().register({ ...verb, flags: { json: { type: "boolean", summary: "s" } } }),
    /global flag --json/,
  );
});

test("every error code has a one-line meaning and a contract exit code", () => {
  for (const [code, spec] of Object.entries(ERROR_CODES)) {
    assert.match(code, /^E_[A-Z_]+$/);
    assert.ok(spec.meaning.length > 0 && !spec.meaning.includes("\n"), code);
    assert.ok([1, 2, 64, 70].includes(spec.exit), code);
  }
});

test("a command group alone lists its subcommands: --help exits 0, bare or mistyped exits 64 with the same list", async () => {
  const registry = new Registry().register(
    { name: "decide new", summary: "open a decision", run: () => ({ text: "" }) },
    { name: "decide resolve", summary: "resolve a decision", run: () => ({ text: "" }) },
    { name: "rooms", summary: "explain rooms", run: () => ({ text: "" }) },
    { name: "rooms status", summary: "agora's version", run: () => ({ text: "" }) },
  );
  /** @param {string[]} argv */
  const call = async (argv) => {
    const stdout = sink();
    const stderr = sink();
    const code = await runCli(registry, argv, { stdout, stderr, env: {}, cwd: "." });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };
  const help = await call(["decide", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^usage: lampstand decide <subcommand>[^\n]*\n\nsubcommands:\n {2}decide new {6}open a decision\n {2}decide resolve {2}resolve a decision\n/);
  assert.equal(JSON.parse((await call(["decide", "--help", "--json"])).stdout).ok, true);

  const bare = await call(["decide"]);
  assert.equal(bare.code, 64);
  assert.match(bare.stderr, /needs a subcommand[\s\S]*decide resolve {2}resolve a decision/);
  const typo = await call(["decide", "resolv"]);
  assert.equal(typo.code, 64);
  assert.match(typo.stderr, /unknown subcommand "decide resolv"[\s\S]*decide new/);
  assert.equal((await call(["nope"])).code, 64);

  // A verb that is also a group keeps its own help and gains the subcommand list.
  const rooms = await call(["rooms", "--help"]);
  assert.equal(rooms.code, 0);
  assert.match(rooms.stdout, /explain rooms[\s\S]*subcommands:\n {2}rooms status {2}agora's version/);
});
