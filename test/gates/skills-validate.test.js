// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { gate, repo, tempDir } from "./helpers.js";

/** @param {string} name @param {string} [extra] @param {string} [body] */
function skill(name, extra = "", body = "# Title\n\nIntro.\n\n## §0 Keeping this skill true\n\nText.\n\n## More\n") {
  return `---\nname: ${name}\ndescription: "Does one thing. Use when it is needed."\n${extra}---\n\n${body}`;
}

/** @param {string} name @param {string} [description] */
function agent(name, description = '"Does one job."') {
  return `---\nname: ${name}\ndescription: ${description}\ntools: read, grep\n---\n\nBody.\n`;
}

test("skills-validate passes well-formed skills and agents", (t) => {
  const root = repo(t, {
    "skills/house/SKILL.md": skill("house"),
    "skills/skill-2/SKILL.md": skill("skill-2", "", `## §0 Maintenance\n\n${"line\n".repeat(400)}`),
    "agents/builder.md": agent("builder"),
  });
  const run = gate("skills-validate.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 0, run.out);
});

test("skills-validate names every frontmatter, body and agent-name defect", (t) => {
  const root = repo(t, {
    "skills/extra/SKILL.md": skill("extra", "license: MIT\n"),
    "skills/folder/SKILL.md": skill("other"),
    "skills/Upper/SKILL.md": skill("Upper"),
    "skills/long/SKILL.md": `---\nname: long\ndescription: "${"x".repeat(1025)}"\n---\n\n## §0 x\n`,
    "skills/newline/SKILL.md": `---\nname: newline\ndescription: "one\\ntwo"\n---\n\n## §0 x\n`,
    "skills/empty/SKILL.md": `---\nname: empty\ndescription: ""\n---\n\n## §0 x\n`,
    "skills/big/SKILL.md": skill("big", "", `## §0 x\n${"line\n".repeat(499)}`),
    "skills/late/SKILL.md": skill("late", "", "## Usage\n\n## §0 Keeping this skill true\n"),
    "skills/bare/SKILL.md": "# no frontmatter\n",
    "skills/nofile/README.md": "x\n",
    "agents/stem.md": agent("other-name"),
    "agents/scout.md": agent("scout"),
    "agents/undescribed.md": "---\nname: undescribed\n---\n",
  });
  const run = gate("skills-validate.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 1, run.out);
  assert.deepEqual(run.stdout.trim().split("\n"), [
    "skills/Upper/SKILL.md: name \"Upper\" is not lowercase letters, digits and hyphens",
    "skills/bare/SKILL.md:1: no frontmatter",
    "skills/big/SKILL.md: body is 501 lines, not under 500",
    "skills/empty/SKILL.md: description is missing or empty",
    "skills/extra/SKILL.md: frontmatter may hold only name and description, not license",
    "skills/folder/SKILL.md: name \"other\" differs from its folder \"folder\"",
    "skills/late/SKILL.md: the first ## section must be headed \"## §0\" (line 6 is \"## Usage\")",
    "skills/long/SKILL.md: description is 1025 characters, over 1024",
    "skills/newline/SKILL.md: description holds a newline",
    "skills/nofile/SKILL.md: missing",
    "agents/scout.md: \"scout\" is a name a host ships or reserves",
    "agents/stem.md: name \"other-name\" differs from its file stem \"stem\"",
    "agents/undescribed.md: description is missing or empty",
  ]);
});

test("skills-validate refuses every host-reserved agent name", (t) => {
  const reserved = ["reviewer", "scout", "task", "sonic", "security-reviewer", "main", "sub"];
  const root = repo(t, Object.fromEntries(reserved.map((name) => [`agents/${name}.md`, agent(name)])));
  const run = gate("skills-validate.js", ["--root", root], tempDir(t));
  assert.equal(run.status, 1, run.out);
  assert.equal(run.stdout.trim().split("\n").length, reserved.length, run.out);
});
