// @ts-check
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openHouseDb } from "../../core/lib/governance/run.js";
import { findExecutable } from "../../core/lib/governance/spawn.js";
import { plant } from "../u1/helpers.js";
import { SPAWNS, envelope, git, jobArgv, lampstand, lampstandAsync, lit, makeHouse, namesIn, tempDir, withPathFirst } from "./helpers.js";

const LONG = { timeout: 600_000 };

test("a job that stages 30,000 new files lands them all, and its commit's name list is exactly them", LONG, (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(dir, `[jobs.bulk]\nargv = ${jobArgv("bulk:30000:bulk")}\nstale_hours = 24\noutputs = ["bulk/"]\ncommit = true\n`);
  const result = lampstand(["run", "bulk", "--json"], { cwd: root, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const run = envelope(result.stdout);
  assert.equal(run.outcome, "landed", run.detail);
  const expected = Array.from({ length: 30000 }, (_, k) => `bulk/d${String(Math.floor(k / 1000)).padStart(2, "0")}/f${String(k).padStart(5, "0")}.txt`).sort();
  assert.deepEqual(run.landed, expected);
  assert.equal(git(root, env, "rev-parse", "HEAD").trim(), run.commit);
  assert.deepEqual(namesIn(root, env, "HEAD"), expected);
  assert.equal(readFileSync(join(root, "bulk", "d29", "f29999.txt"), "utf8"), "29999\n");
});

test("an output outside outputs rejects the run and lands nothing, not even the paths that were allowed", (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(
    dir,
    `[jobs.stray]\nargv = ${jobArgv("write:reports/ok.md=fine", "write:principles/sneaky.md=no")}\nstale_hours = 24\noutputs = ["reports/"]\ncommit = true\n`,
  );
  const head = git(root, env, "rev-parse", "HEAD");
  const result = lampstand(["run", "stray", "--json"], { cwd: root, env });
  assert.equal(result.status, 1);
  const run = envelope(result.stdout);
  assert.equal(run.outcome, "rejected");
  assert.match(run.detail, /principles\/sneaky\.md: outside outputs and mutates/);
  assert.deepEqual(run.landed, []);
  assert.equal(existsSync(join(root, "reports", "ok.md")), false);
  assert.equal(existsSync(join(root, "principles", "sneaky.md")), false);
  assert.equal(git(root, env, "rev-parse", "HEAD"), head);
});

test("a prefix matches whole path segments: outputs reports/ does not cover reports-old/", (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(dir, `[jobs.near]\nargv = ${jobArgv("write:reports-old/x.md=x")}\nstale_hours = 24\noutputs = ["reports"]\n`);
  const run = envelope(lampstand(["run", "near", "--json"], { cwd: root, env }).stdout);
  assert.equal(run.outcome, "rejected");
  assert.equal(existsSync(join(root, "reports-old")), false);
});

test("a pre-commit hook that refuses gives not_landed and leaves HEAD where it was", SPAWNS, (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(dir, `[jobs.hooked]\nargv = ${jobArgv("write:reports/a.md=a")}\nstale_hours = 24\noutputs = ["reports/"]\ncommit = true\n`);
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho refused by policy >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const head = git(root, env, "rev-parse", "HEAD");
  const result = lampstand(["run", "hooked", "--json"], { cwd: root, env });
  assert.equal(result.status, 1);
  const run = envelope(result.stdout);
  assert.equal(run.outcome, "not_landed");
  assert.match(run.detail, /git commit was refused.*refused by policy/s);
  assert.equal(run.commit, null);
  assert.equal(git(root, env, "rev-parse", "HEAD"), head);
});

test("a mutates file changed in the house during the run is not clobbered, and the run is not_landed", (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(
    dir,
    `[jobs.edit]\nargv = ${jobArgv("write:notes.md=job version", "live:notes.md=edited by hand")}\nstale_hours = 24\nmutates = ["notes.md"]\ncommit = true\n`,
  );
  plant(root, { "notes.md": "original" });
  git(root, env, "add", "notes.md");
  git(root, env, "commit", "-q", "-m", "notes");
  const head = git(root, env, "rev-parse", "HEAD");
  const run = envelope(lampstand(["run", "edit", "--json"], { cwd: root, env }).stdout);
  assert.equal(run.outcome, "not_landed");
  assert.match(run.detail, /notes\.md: changed in the house during the run; left as it is/);
  assert.equal(readFileSync(join(root, "notes.md"), "utf8"), "edited by hand");
  assert.deepEqual(run.landed, []);
  assert.equal(git(root, env, "rev-parse", "HEAD"), head);
});

test("an unchanged mutates file is replaced and committed; an output that already exists is never replaced", SPAWNS, (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(
    dir,
    `[jobs.edit]\nargv = ${jobArgv("write:notes.md=job version", "write:reports/a.md=new")}\nstale_hours = 24\nmutates = ["notes.md"]\noutputs = ["reports/"]\ncommit = true\n`,
  );
  plant(root, { "notes.md": "original", "reports/a.md": "already here" });
  git(root, env, "add", "notes.md", "reports/a.md");
  git(root, env, "commit", "-q", "-m", "seed");
  const run = envelope(lampstand(["run", "edit", "--json"], { cwd: root, env }).stdout);
  assert.equal(run.outcome, "not_landed");
  assert.deepEqual(run.landed, ["notes.md"]);
  assert.match(run.detail, /reports\/a\.md: already exists in the house; not replaced/);
  assert.equal(readFileSync(join(root, "notes.md"), "utf8"), "job version");
  assert.equal(readFileSync(join(root, "reports", "a.md"), "utf8"), "already here");
  assert.deepEqual(namesIn(root, env, "HEAD"), ["notes.md"]);
});

test("a commit carries only the run's paths: the user's own staged work stays staged and out of it", SPAWNS, (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(dir, `[jobs.one]\nargv = ${jobArgv("write:reports/a.md=a")}\nstale_hours = 24\noutputs = ["reports/"]\ncommit = true\n`);
  plant(root, { "mine.md": "work in progress" });
  git(root, env, "add", "mine.md");
  const run = envelope(lampstand(["run", "one", "--json"], { cwd: root, env }).stdout);
  assert.equal(run.outcome, "landed", run.detail);
  assert.deepEqual(namesIn(root, env, "HEAD"), ["reports/a.md"]);
  assert.equal(git(root, env, "diff", "--cached", "--name-only").trim(), "mine.md");
});

test("two concurrent jobs never claim each other's paths", SPAWNS, async (t) => {
  const dir = tempDir(t);
  const go = join(dir, "go");
  const jobs = [
    `[jobs.alpha]\nargv = ${jobArgv(`wait:${go}`, "write:alpha/a1.md=a", "write:alpha/a2.md=a", "write:shared/same.md=alpha")}`,
    `stale_hours = 24\noutputs = ["alpha/", "shared/"]\ncommit = true\n`,
    `[jobs.beta]\nargv = ${jobArgv(`wait:${go}`, "write:beta/b1.md=b", "write:shared/same.md=beta")}`,
    `stale_hours = 24\noutputs = ["beta/", "shared/"]\ncommit = true\n`,
  ].join("\n");
  const { root, env, house } = makeHouse(dir, jobs);
  const runs = [lampstandAsync(["run", "alpha", "--json"], { cwd: root, env }), lampstandAsync(["run", "beta", "--json"], { cwd: root, env })];
  // Both jobs are started and blocked before either stages anything; releasing them together makes them land at once.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  writeFileSync(go, "");
  const [alpha, beta] = (await Promise.all(runs)).map((result) => envelope(result.stdout));
  // Each reply must be a run result: an error envelope has no job, and would make the comparisons below vacuous.
  for (const [name, reply] of [["alpha", alpha], ["beta", beta]]) assert.equal(reply.job, name, JSON.stringify(reply));

  const own = { alpha: ["alpha/a1.md", "alpha/a2.md"], beta: ["beta/b1.md"] };
  const winner = alpha.landed.includes("shared/same.md") ? alpha : beta;
  const loser = winner === alpha ? beta : alpha;
  assert.deepEqual(winner.landed, [...own[/** @type {"alpha" | "beta"} */ (winner.job)], "shared/same.md"].sort(), JSON.stringify(winner));
  assert.equal(winner.outcome, "landed", winner.detail);
  assert.deepEqual(loser.landed, own[/** @type {"alpha" | "beta"} */ (loser.job)], JSON.stringify(loser));
  assert.equal(loser.outcome, "not_landed", JSON.stringify(loser));
  assert.match(loser.detail, /shared\/same\.md: already exists in the house; not replaced/);
  assert.equal(readFileSync(join(root, "shared", "same.md"), "utf8"), winner.job);
  assert.deepEqual(namesIn(root, env, winner.commit), winner.landed);
  assert.deepEqual(namesIn(root, env, loser.commit), loser.landed);
  assert.notEqual(winner.commit, loser.commit);

  const state = openHouseDb(house(), env);
  try {
    const rows = state.db.once("SELECT job, landed FROM job_runs ORDER BY job", (s) => s.all());
    assert.deepEqual(rows.map((row) => [row.job, JSON.parse(String(row.landed))]), [
      ["alpha", alpha.landed],
      ["beta", beta.landed],
    ]);
    assert.equal(state.db.get("SELECT count(*) AS n FROM job_locks")?.n, 0);
  } finally {
    state.db.close();
  }
});

test("a second run of a job that is still running is skipped", SPAWNS, async (t) => {
  const dir = tempDir(t);
  const started = join(dir, "started");
  const go = join(dir, "go");
  const { root, env } = makeHouse(dir, `[jobs.slow]\nargv = ${jobArgv(`touch:${started}`, `wait:${go}`)}\nstale_hours = 24\n`);
  const first = lampstandAsync(["run", "slow", "--json"], { cwd: root, env });
  for (let k = 0; k < 300 && !existsSync(started); k++) await new Promise((resolve) => setTimeout(resolve, 50));
  const second = lampstand(["run", "slow", "--json"], { cwd: root, env });
  writeFileSync(go, "");
  assert.equal(second.status, 0);
  assert.equal(envelope(second.stdout).outcome, "skipped");
  assert.equal(envelope((await first).stdout).outcome, "landed");
});

test("a job that exits non-zero is failed with its exit code and lands nothing", (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(dir, `[jobs.bad]\nargv = ${jobArgv("write:reports/a.md=a", "exit:3")}\nstale_hours = 24\noutputs = ["reports/"]\n`);
  const result = lampstand(["run", "bad", "--json"], { cwd: root, env });
  assert.equal(result.status, 1);
  const run = envelope(result.stdout);
  assert.equal(run.outcome, "failed");
  assert.equal(run.exit_code, 3);
  assert.equal(existsSync(join(root, "reports")), false);
});

test("a job sees HOUSE_RUN_OUT, HOUSE_ROOT and HOUSE_RUN_ID, and only the variables it names in env", (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(
    dir,
    `[jobs.vars]\nargv = ${jobArgv("env:HOUSE_ROOT", "env:HOUSE_RUN_ID", "env:U4_NAMED", "env:U4_SECRET")}\nstale_hours = 24\noutputs = ["env/"]\nenv = ["U4_NAMED"]\n`,
  );
  const run = envelope(lampstand(["run", "vars", "--json"], { cwd: root, env: { ...env, U4_NAMED: "yes", U4_SECRET: "leak" } }).stdout);
  assert.equal(run.outcome, "landed", run.detail);
  const read = (/** @type {string} */ name) => readFileSync(join(root, "env", `${name}.txt`), "utf8");
  assert.equal(read("HOUSE_ROOT"), root);
  assert.equal(read("HOUSE_RUN_ID"), run.run_id);
  assert.equal(read("U4_NAMED"), "yes");
  assert.equal(read("U4_SECRET"), "<unset>");
});

test("no step of a run invokes git status: a git that fails on status still lands and commits", SPAWNS, (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(dir, `[jobs.one]\nargv = ${jobArgv("write:reports/a.md=a")}\nstale_hours = 24\noutputs = ["reports/"]\ncommit = true\n`);
  const realGit = findExecutable("git", env);
  assert.ok(realGit, "git is on PATH");
  const shims = join(dir, "shims");
  const log = join(dir, "git-calls.jsonl");
  const shim = join(shims, "shim.js");
  plant(shims, {
    "shim.js": [
      'import { appendFileSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
      'if (args.find((arg) => !arg.startsWith("-")) === "status") { process.stderr.write("shim: git status is forbidden\\n"); process.exit(1); }',
      `const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });`,
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
  });
  if (process.platform === "win32") {
    plant(shims, { "git.cmd": `@"${process.execPath}" "${shim}" %*\r\n@exit /b %ERRORLEVEL%\r\n` });
  } else {
    plant(shims, { git: `#!/bin/sh\nexec '${process.execPath}' '${shim}' "$@"\n` });
    chmodSync(join(shims, "git"), 0o755);
  }
  const shimmed = withPathFirst(env, shims);
  assert.equal(findExecutable("git", shimmed)?.startsWith(shims), true, "the shim is the git found first on PATH");
  // The shim refuses status, so a code path that asked git what changed would fail here.
  assert.equal(lampstand(["run", "--json", "one"], { cwd: root, env: shimmed }).status, 0);

  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const subcommands = calls.map((args) => args.find((/** @type {string} */ arg) => !arg.startsWith("-")));
  assert.equal(subcommands.includes("status"), false);
  assert.deepEqual(subcommands, ["rev-parse", "rev-parse", "add", "commit", "rev-parse", "show"]);
  assert.deepEqual(namesIn(root, env, "HEAD"), ["reports/a.md"]);
});

test("run --status reports OK, STALE, NOT_LANDED and REJECTED from each job's last outcome and stale_hours", (t) => {
  const dir = tempDir(t);
  const table = (/** @type {string} */ id) => `[jobs.${id}]\nargv = [${lit(process.execPath)}]\nstale_hours = 24\n`;
  const { root, env, house } = makeHouse(dir, ["fresh", "old", "never", "refused", "partial", "broke"].map(table).join("\n"));
  const state = openHouseDb(house(), env);
  const hoursAgo = (/** @type {number} */ h) => new Date(Date.now() - h * 3_600_000).toISOString();
  const insert = (/** @type {string} */ job, /** @type {string} */ outcome, /** @type {number} */ h) =>
    state.db.run("INSERT INTO job_runs (job, started_at, finished_at, outcome, run_id) VALUES (?, ?, ?, ?, ?)", job, hoursAgo(h), hoursAgo(h), outcome, `${job}-${h}-${outcome}`);
  try {
    insert("fresh", "landed", 2);
    insert("fresh", "skipped", 1);
    insert("old", "landed", 30);
    insert("refused", "landed", 5);
    insert("refused", "rejected", 1);
    insert("partial", "not_landed", 1);
    insert("broke", "landed", 5);
    insert("broke", "failed", 1);
  } finally {
    state.db.close();
  }
  const result = lampstand(["run", "--status", "--json"], { cwd: root, env });
  assert.equal(result.status, 1);
  const status = envelope(result.stdout);
  assert.equal(status.ok, false);
  assert.deepEqual(
    Object.fromEntries(status.jobs.map((/** @type {{ job: string, health: string }} */ job) => [job.job, job.health])),
    { broke: "OK", fresh: "OK", never: "STALE", old: "STALE", partial: "NOT_LANDED", refused: "REJECTED" },
  );
  const one = lampstand(["run", "--status", "fresh"], { cwd: root, env });
  assert.equal(one.status, 0);
  assert.match(one.stdout, /^OK\s+fresh\s+last landed /);
});

test("an undeclared job is a usage error naming the declared ones", (t) => {
  const dir = tempDir(t);
  const { root, env } = makeHouse(dir, `[jobs.real]\nargv = [${lit(process.execPath)}]\nstale_hours = 1\n`);
  const result = lampstand(["run", "nope", "--json"], { cwd: root, env });
  assert.equal(result.status, 64);
  assert.match(envelope(result.stdout).error.message, /no job "nope" in \[jobs\]; declared: real/);
});
