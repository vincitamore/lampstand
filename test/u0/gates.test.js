import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** @param {string} script @param {string[]} [args] */
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * A temp directory removed when the test ends; realpath so it matches the paths the scripts print.
 * @param {{ after(fn: () => void): void }} t
 */
function tempDir(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-u0-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Plants a repository at `repo` holding a copy of dev/<script> and the given files.
 * @param {string} repo @param {string} script @param {Record<string, string>} files
 */
function plant(repo, script, files) {
  mkdirSync(join(repo, "dev"), { recursive: true });
  copyFileSync(join(root, "dev", script), join(repo, "dev", script));
  for (const [name, content] of Object.entries({ "package.json": '{"type":"module"}\n', ...files })) {
    writeFileSync(join(repo, name), content);
  }
  return join(repo, "dev", script);
}

const agreeing = {
  "package.json": `${JSON.stringify({ name: "x", version: "1.2.3", type: "module" })}\n`,
  "plugin.yaml": "manifest_version: 2\nname: x\nversion: 1.2.3\n",
  "CHANGELOG.md": "# Changelog\n\n## 1.2.3\n\n## 1.2.2\n",
};

test("version-sync passes on the real repository", () => {
  const { status, output } = run(join(root, "dev", "version-sync.js"));
  assert.equal(status, 0, output);
});

test("version-sync passes when all sources agree, including quoted YAML and a matching tag", (t) => {
  const quoted = { ...agreeing, "plugin.yaml": 'name: x\nversion: "1.2.3" # release\nconfig_schema:\n  version:\n    type: str\n' };
  /** @type {Array<[Record<string, string>, string[]]>} */
  const cases = [
    [agreeing, []],
    [agreeing, ["--tag", "v1.2.3"]],
    [quoted, []],
  ];
  for (const [files, args] of cases) {
    const { status, output } = run(plant(tempDir(t), "version-sync.js", files), args);
    assert.equal(status, 0, output);
  }
});

test("version-sync fails when any source disagrees or is missing", (t) => {
  const cases = {
    "package.json differs": { "package.json": '{"version":"1.2.4","type":"module"}\n' },
    "package.json has no version": { "package.json": '{"type":"module"}\n' },
    "plugin.yaml differs": { "plugin.yaml": "name: x\nversion: 1.2.4\n" },
    "plugin.yaml version only nested": { "plugin.yaml": "name: x\nconfig_schema:\n  version: 1.2.3\n" },
    "plugin.yaml version twice": { "plugin.yaml": "version: 1.2.3\nversion: 1.2.3\n" },
    "newest changelog heading differs": { "CHANGELOG.md": "# Changelog\n\n## 1.2.4\n\n## 1.2.3\n" },
    "changelog has no heading": { "CHANGELOG.md": "# Changelog\n" },
  };
  for (const [name, override] of Object.entries(cases)) {
    const { status, output } = run(plant(tempDir(t), "version-sync.js", { ...agreeing, ...override }));
    assert.equal(status, 1, `${name}: ${output}`);
  }
  for (const tag of ["v1.2.4", "1.2.3"]) {
    const { status, output } = run(plant(tempDir(t), "version-sync.js", agreeing), ["--tag", tag]);
    assert.equal(status, 1, `--tag ${tag}: ${output}`);
  }
});

test("clean-room passes on the real repository", () => {
  const { status, output } = run(join(root, "dev", "clean-room-check.js"));
  assert.equal(status, 0, output);
});

test("clean-room names every marker planted in an ancestor", (t) => {
  for (const marker of ["AGENTS.md", "CLAUDE.md", "house.toml", join(".claude", "CLAUDE.md"), join(".omp", "rules")]) {
    const house = tempDir(t);
    mkdirSync(dirname(join(house, marker)), { recursive: true });
    if (marker.startsWith(".omp")) mkdirSync(join(house, marker));
    else writeFileSync(join(house, marker), "");
    const script = plant(join(house, "work", "lampstand"), "clean-room-check.js", {});
    const { status, output } = run(script);
    assert.equal(status, 1, `${marker}: ${output}`);
    const reported = marker.startsWith(".omp") ? join(house, ".omp") : join(house, marker);
    assert.ok(output.includes(reported), `${marker} not reported:\n${output}`);
  }
});

test("clean-room passes a settings-only .claude and an empty .omp above the repository", (t) => {
  const house = tempDir(t);
  mkdirSync(join(house, ".claude"));
  writeFileSync(join(house, ".claude", "settings.local.json"), "{}");
  mkdirSync(join(house, ".omp"));
  const script = plant(join(house, "work", "lampstand"), "clean-room-check.js", {});
  const { status, output } = run(script);
  assert.equal(status, 0, output);
});

test("clean-room ignores markers inside the repository itself", (t) => {
  const repo = join(tempDir(t), "lampstand");
  const script = plant(repo, "clean-room-check.js", { "AGENTS.md": "" });
  const { output } = run(script);
  assert.ok(!output.includes(join(repo, "AGENTS.md")), output);
});
