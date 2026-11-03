// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { gate, repo, tempDir } from "./helpers.js";

const CODE = {
  "core/names.js": 'export const TOOL = "rsync";\n',
  "core/run.js": [
    'import { spawnSync } from "node:child_process";',
    "/** @param {string} file @param {string[]} args */",
    "export function runTool(file, args) {",
    "  return spawnSync(file, args, { windowsHide: true });",
    "}",
    "",
  ].join("\n"),
  "core/a.js": [
    'import { spawnSync, execSync as shellOut, execFileSync } from "node:child_process";',
    'import { TOOL } from "./names.js";',
    'import { runTool } from "./run.js";',
    'const GIT = "git";',
    "// spawnSync(\"commented\") is not a call, and neither is this string: 'spawnSync(\"quoted\")'",
    "const re = /spawnSync\\(\"regex\"\\)/;",
    "export function go(argv, env) {",
    '  spawnSync(GIT, ["rev-parse"]);',
    "  execFileSync(TOOL, []);",
    '  runTool("tar", ["-x"]);',
    '  const exe = which("omp", env) ?? null;',
    '  spawnSync(exe, ["--version"]);',
    '  shellOut("ls -la");',
    "  spawnSync(argv[0], argv.slice(1));",
    "  return re;",
    "}",
    "/** @param {string} name @param {unknown} env */",
    "function which(name, env) {",
    "  return env ? name : null;",
    "}",
    "",
  ].join("\n"),
  "core/host.js": [
    'import { spawnSync } from "node:child_process";',
    "export function realHost() {",
    "  return {",
    "    run(command, args) {",
    "      return spawnSync(command, args);",
    "    },",
    "  };",
    "}",
    "export function use(host, db) {",
    '  db.run("SELECT 1 FROM t");',
    '  return host.run("crontab", ["-l"]);',
    "}",
    "",
  ].join("\n"),
  "hosts/hermes/node.py": [
    "import shutil",
    "import subprocess",
    "",
    "",
    "def find_node():",
    '    return shutil.which("node")',
    "",
    "",
    "def run(args):",
    "    node = find_node()",
    '    # subprocess.run(["commented"])',
    "    return subprocess.run([node, *args], check=False)",
    "",
  ].join("\n"),
};

const DISPOSITIONS = JSON.stringify({
  dynamic: [{ file: "core/a.js", expression: "argv[0]", covers: ["the commands you declare"], why: "a job's own argv" }],
});

const SECURITY = "Runs `git`, `rsync`, `tar`, `omp`, `crontab`, `node` and `ls` through the shell (`sh` or `cmd.exe`), and the commands you declare.\n";

test("disclosure-check passes when every command the code can start is named in SECURITY.md", (t) => {
  const root = repo(t, { ...CODE, "SECURITY.md": SECURITY, "dev/disclosure-dispositions.json": DISPOSITIONS });
  const run = gate("disclosure-check.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 0, run.out);
  const listed = [...run.stdout.matchAll(/^ {2}ok +(\S+) {2}\(/gm)].map((m) => m[1]);
  assert.deepEqual(listed, ["cmd.exe", "crontab", "git", "ls", "node", "omp", "rsync", "sh", "tar"]);
  assert.doesNotMatch(run.stdout, /commented|quoted|regex|SELECT/);
});

test("disclosure-check names each undisclosed command with its call sites, and each unexplained dynamic site", (t) => {
  const security = SECURITY.replace("`rsync`, ", "").replace("`crontab`, ", "").replace(", and the commands you declare", "");
  const dispositions = JSON.stringify({
    dynamic: [{ file: "core/a.js", expression: "argv[0]", covers: ["the commands you declare"], why: "a job's own argv" }],
  });
  const root = repo(t, {
    ...CODE,
    "core/b.js": 'import { spawn } from "child_process";\nexport const start = () => spawn(process.env.TOOL);\n',
    "SECURITY.md": security,
    "dev/disclosure-dispositions.json": dispositions,
  });
  const run = gate("disclosure-check.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 1, run.out);
  const findings = run.stdout.split("\n").filter((line) => line.startsWith("disclosure-check: ") && !line.includes("process-starting calls"));
  assert.deepEqual(findings, [
    "disclosure-check: crontab is not mentioned in SECURITY.md; started at core/host.js:11",
    "disclosure-check: rsync is not mentioned in SECURITY.md; started at core/a.js:9",
    'disclosure-check: core/a.js:14: its disposition covers "the commands you declare", which SECURITY.md does not mention',
    'disclosure-check: core/b.js:2: the command "process.env.TOOL" cannot be named; add a disposition to dev/disclosure-dispositions.json',
  ]);
});
