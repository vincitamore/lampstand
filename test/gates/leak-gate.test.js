// @ts-check
// Every leak below is assembled at run time, so this file itself holds none for the gate to find.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gate, repo, tempDir } from "./helpers.js";

const at = "@";
const secretName = "zebulon";
const leaks = {
  windowsHome: ["C:", "Users", secretName, "repo"].join("\\"),
  windowsEscaped: ["D:", "Users", secretName, "x"].join("\\\\"),
  windowsForward: ["C:", "Users", secretName, "x"].join("/"),
  macHome: `/${"Users"}/${secretName}/code`,
  linuxHome: `/${"home"}/${secretName}/.config`,
  privateKey: `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`,
  aws: `${"AKIA"}ABCDEFGHIJKLMNOP`,
  github: `${"ghp"}_${"a".repeat(36)}`,
  openai: `${"sk"}-proj-${"Ab1".repeat(12)}`,
  email: `${secretName}${at}example.com`,
};

test("leak-gate passes placeholders, noreply and example.invalid addresses, and ignored files", (t) => {
  const root = repo(t, {
    ".gitignore": "private/\n",
    "README.md": [
      `A home such as C:\\Users\\<name>\\code or /home/<name>/repo is a placeholder.`,
      `Commits from 123+someone${at}users.noreply.github.com and noreply${at}github.com, mail to ana${at}example.invalid.`,
      "A short sk-abc is not a key.",
      "",
    ].join("\n"),
    "private/notes.txt": `${leaks.email}\n`,
  });
  const run = gate("leak-gate.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 0, run.out);
});

test("leak-gate reports path, line and kind of every leak and never the matched text", (t) => {
  const root = repo(t, {
    "docs/a.md": `${leaks.windowsHome}\n${leaks.windowsEscaped}\n${leaks.windowsForward}\n${leaks.macHome}\n${leaks.linuxHome}\n`,
    "test/fixture.json": `{\n  "key": "${leaks.privateKey}",\n  "aws": "${leaks.aws}",\n  "gh": "${leaks.github}",\n  "ai": "${leaks.openai}"\n}\n`,
    "core/x.js": `// contact ${leaks.email}\n`,
  });
  const run = gate("leak-gate.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 1, run.out);
  assert.deepEqual(run.stdout.trim().split("\n").sort(), [
    "core/x.js:1:email",
    "docs/a.md:1:home-path",
    "docs/a.md:2:home-path",
    "docs/a.md:3:home-path",
    "docs/a.md:4:home-path",
    "docs/a.md:5:home-path",
    "test/fixture.json:2:private-key",
    "test/fixture.json:3:aws-access-key",
    "test/fixture.json:4:github-token",
    "test/fixture.json:5:openai-anthropic-key",
  ]);
  assert.ok(!run.out.includes(secretName), "the output repeats a matched name");
  for (const value of Object.values(leaks)) assert.ok(!run.out.includes(value), "the output repeats a matched leak");
});
