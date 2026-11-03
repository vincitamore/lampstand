#!/usr/bin/env node
// @ts-check
// Skills load under strict Agent Skills validation on both hosts, so a skill whose frontmatter carries an extra key, a
// name that differs from its folder or a multi-line description is dropped at load. Each SKILL.md has frontmatter
// with exactly `name` and `description`, a body under 500 lines, and its maintenance section (`## §0`) as the first
// section. Each agent has `name` equal to its file stem and a description, and takes no name a host ships or
// reserves, since a same-named agent shadows the host's or is shadowed by it.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../core/lib/frontmatter.js";
import { isLampstandError } from "../core/lib/errors.js";
import { GateError, parseArgs, readTextFile, report, runGate } from "./gate-lib.js";

export const RESERVED_AGENTS = Object.freeze(["reviewer", "scout", "task", "sonic", "security-reviewer", "main", "sub"]);
const NAME = /^[a-z0-9-]+$/;
const DESCRIPTION_MAX = 1024;
const BODY_LINES_MAX = 500;

/** @param {string} dir */
function entries(dir) {
  try {
    return readdirSync(dir).sort();
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw new GateError(`cannot list ${dir}`);
  }
}

/**
 * The parsed frontmatter of a Markdown file, or a finding.
 * @param {string} root
 * @param {string} rel
 * @returns {{ frontmatter: Record<string, unknown>, body: string, bodyLine: number } | string}
 */
function load(root, rel) {
  const text = readTextFile(join(root, rel));
  if (text === null) return `${rel}: not UTF-8 text`;
  try {
    const parsed = parseFrontmatter(text, rel);
    if (parsed.frontmatter === null) return `${rel}:1: no frontmatter`;
    return { frontmatter: parsed.frontmatter, body: parsed.body, bodyLine: parsed.bodyLine };
  } catch (error) {
    if (isLampstandError(error)) return error.message;
    throw error;
  }
}

/** @param {string} body */
function bodyLines(body) {
  if (body === "") return 0;
  return (body.endsWith("\n") ? body.slice(0, -1) : body).split("\n").length;
}

/**
 * @param {string} root
 * @param {string[]} out
 */
function checkSkills(root, out) {
  let count = 0;
  for (const dir of entries(join(root, "skills"))) {
    if (!statSync(join(root, "skills", dir)).isDirectory()) continue;
    const rel = `skills/${dir}/SKILL.md`;
    let exists = false;
    try {
      exists = statSync(join(root, rel)).isFile();
    } catch {}
    if (!exists) {
      out.push(`${rel}: missing`);
      continue;
    }
    count++;
    const loaded = load(root, rel);
    if (typeof loaded === "string") {
      out.push(loaded);
      continue;
    }
    const { frontmatter, body, bodyLine } = loaded;
    const keys = Object.keys(frontmatter);
    const extra = keys.filter((key) => key !== "name" && key !== "description");
    if (extra.length > 0) out.push(`${rel}: frontmatter may hold only name and description, not ${extra.join(", ")}`);
    const { name, description } = frontmatter;
    if (typeof name !== "string") out.push(`${rel}: name is missing or not a string`);
    else {
      if (!NAME.test(name)) out.push(`${rel}: name ${JSON.stringify(name)} is not lowercase letters, digits and hyphens`);
      if (name !== dir) out.push(`${rel}: name ${JSON.stringify(name)} differs from its folder ${JSON.stringify(dir)}`);
    }
    if (typeof description !== "string" || description.trim() === "") out.push(`${rel}: description is missing or empty`);
    else {
      if (description.includes("\n")) out.push(`${rel}: description holds a newline`);
      const length = [...description].length;
      if (length > DESCRIPTION_MAX) out.push(`${rel}: description is ${length} characters, over ${DESCRIPTION_MAX}`);
    }
    const lines = bodyLines(body);
    if (lines >= BODY_LINES_MAX) out.push(`${rel}: body is ${lines} lines, not under ${BODY_LINES_MAX}`);
    const rows = body.split("\n");
    let fence = false;
    let first = -1;
    for (let k = 0; k < rows.length; k++) {
      if (/^ {0,3}(```|~~~)/.test(rows[k])) fence = !fence;
      if (!fence && /^##[ \t]/.test(rows[k])) {
        first = k;
        break;
      }
    }
    if (first < 0 || !/^##[ \t]+§0(?:\s|$)/.test(rows[first])) {
      const where = first < 0 ? "it has no ## section" : `line ${bodyLine + first} is ${JSON.stringify(rows[first])}`;
      out.push(`${rel}: the first ## section must be headed "## §0" (${where})`);
    }
  }
  return count;
}

/**
 * @param {string} root
 * @param {string[]} out
 */
function checkAgents(root, out) {
  let count = 0;
  for (const file of entries(join(root, "agents"))) {
    if (!file.endsWith(".md") || !statSync(join(root, "agents", file)).isFile()) continue;
    count++;
    const rel = `agents/${file}`;
    const stem = file.slice(0, -3);
    const loaded = load(root, rel);
    if (typeof loaded === "string") {
      out.push(loaded);
      continue;
    }
    const { name, description } = loaded.frontmatter;
    if (typeof name !== "string") out.push(`${rel}: name is missing or not a string`);
    else if (name !== stem) out.push(`${rel}: name ${JSON.stringify(name)} differs from its file stem ${JSON.stringify(stem)}`);
    if (typeof description !== "string" || description.trim() === "") out.push(`${rel}: description is missing or empty`);
    for (const candidate of new Set([stem, typeof name === "string" ? name : stem])) {
      if (RESERVED_AGENTS.includes(candidate)) out.push(`${rel}: ${JSON.stringify(candidate)} is a name a host ships or reserves`);
    }
  }
  return count;
}

runGate("skills-validate", "node dev/skills-validate.js [--root <dir>]", () => {
  const { root } = parseArgs(process.argv.slice(2));
  /** @type {string[]} */
  const findings = [];
  const skills = checkSkills(root, findings);
  const agents = checkAgents(root, findings);
  return report("skills-validate", findings, `${skills} skills and ${agents} agents valid`, `${findings.length} problems`);
});
