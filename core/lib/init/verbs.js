// @ts-check
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { hasHouseToml } from "../config.js";
import { fail } from "../errors.js";
import { WORKSPACE_FLAGS, resolveHouse } from "../root.js";
import { today } from "../constitution/curate.js";
import { answersFrom, askAnswers, kernelFit, kernelFitText, readAnswersFile } from "./answers.js";
import { commitLine } from "../commit.js";
import { initHouse, PLANT_MESSAGE } from "./init.js";
import { PACKAGE_ROOT } from "./plant.js";
import { regionProblem } from "./region.js";
import { upgradeHouse, upgradeMessage } from "./upgrade.js";

/** @typedef {import("../cli.js").Verb} Verb */
/** @typedef {import("../constitution/rules.js").Finding} Finding */
/** @typedef {import("./answers.js").AnswersFile} AnswersFile */

/** @param {Finding} finding */
function findingLine(finding) {
  const where = finding.path && !finding.message.startsWith(finding.path) ? ` ${finding.path}:` : "";
  return `${finding.level} [${finding.rule}]${where} ${finding.message}`;
}

/** @param {string} label @param {string[]} paths */
function listing(label, paths) {
  return paths.length === 0 ? [] : [`${label}:`, ...paths.map((path) => `  ${path}`)];
}

/**
 * The compile and region lines shared by init and upgrade, and whether either leaves something to act on.
 * @param {{ compile: { ok: boolean, written: string[], findings: Finding[] }, region: string }} result
 */
function compileLines(result) {
  const lines = [];
  if (!result.compile.ok) lines.push("compile refused: no projection written, AGENTS.md region not written");
  else lines.push(result.compile.written.length === 0 ? "projections: nothing changed" : `projections: wrote ${result.compile.written.join(", ")}`);
  lines.push(...result.compile.findings.filter((finding) => finding.level === "error").map(findingLine));
  if (result.region === "written") lines.push("AGENTS.md region: written");
  else if (result.region === "unchanged") lines.push("AGENTS.md region: unchanged");
  else if (result.region === "no-file" || result.region === "no-region") lines.push(regionProblem(result.region));
  const actionable = !result.compile.ok || result.region === "no-file" || result.region === "no-region";
  return { lines, actionable };
}

/**
 * The terminal conversation: explanations and prompts on stderr, so --json keeps stdout to its one object. Lines
 * are queued as they arrive, so answers pasted several at once are each kept for the question they answer. An
 * answer the terminal did not echo next to its prompt (one that was queued, or any answer without a terminal) ends
 * the prompt's line, so the next explanation never starts in the middle of it.
 * @param {NodeJS.ReadableStream} [input]
 * @param {NodeJS.WritableStream} [output]
 */
export function terminal(input = process.stdin, output = process.stderr) {
  const rl = createInterface({ input, output });
  /** @type {string[]} */
  const lines = [];
  /** @type {((line: string | null) => void) | null} */
  let waiting = null;
  let ended = false;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      lines.push(line);
    }
  });
  rl.on("close", () => {
    ended = true;
    if (waiting) waiting(null);
  });
  return {
    /** @param {string} text */
    show(text) {
      output.write(`${text}\n`);
    },
    /** @param {string} question @returns {Promise<string>} */
    async ask(question) {
      rl.setPrompt(question);
      rl.prompt(true);
      const queued = lines.shift();
      const line = queued !== undefined ? queued : ended ? null : await new Promise((resolve) => (waiting = resolve));
      if (line === null) throw fail("E_USAGE", "the input ended before every question was answered; nothing was planted");
      if (!rl.terminal || queued !== undefined) output.write("\n");
      return line;
    },
    close() {
      rl.close();
    },
  };
}

/** @type {Verb} */
export const initVerb = {
  name: "init",
  summary: "plant a house: the six Plant questions (or --answers), missing files only, git init, compile, commit what was planted",
  args: { min: 0, max: 1, usage: "[<dir>]" },
  flags: {
    answers: { type: "string", summary: "a TOML file holding the answers, for planting without a terminal" },
    default: { type: "boolean", summary: "record this house as default_house in per-user config (through the seat ledger)" },
    "no-lattice": { type: "boolean", summary: "start with no principles instead of planting the lattice" },
  },
  async run(context) {
    const noLattice = context.flags["no-lattice"] === true;
    const named = context.args[0] === undefined ? undefined : resolve(context.cwd, context.args[0]);
    /** @type {AnswersFile | null} */
    let file = null;
    let dir;
    if (typeof context.flags.answers === "string") {
      file = readAnswersFile(resolve(context.cwd, context.flags.answers));
      const where = file.where === undefined ? undefined : resolve(context.cwd, file.where);
      if (named !== undefined && where !== undefined && named !== where) {
        throw fail("E_USAGE", `<dir> ${named} and the answers' where ${where} name different folders; give one`);
      }
      dir = named ?? where ?? resolve(context.cwd);
    } else {
      const target = named ?? resolve(context.cwd);
      if (hasHouseToml(target)) {
        dir = target;
      } else {
        if (!process.stdin.isTTY) {
          throw fail("E_USAGE", "lampstand init asks its questions on a terminal; here there is none, so pass --answers <file>");
        }
        const talk = terminal();
        try {
          ({ dir, file } = await askAnswers(talk, {
            where: target,
            resolve: (answer) => resolve(context.cwd, answer),
            planted: hasHouseToml,
            noLattice,
          }));
        } finally {
          talk.close();
        }
      }
    }

    const standing = hasHouseToml(dir);
    const answers = standing ? null : answersFrom(file ?? {}, dir, { noLattice });
    if (answers !== null) {
      const fit = kernelFit(answers);
      if (fit.over > 0) {
        const where = typeof context.flags.answers === "string" ? { path: resolve(context.cwd, context.flags.answers) } : {};
        throw fail("E_SCHEMA", `nothing planted: ${kernelFitText(fit)}`, where);
      }
    }
    const result = initHouse({
      dir,
      answers,
      channelManners: file === null ? undefined : answersFrom(file, dir, { noLattice }).channelManners,
      makeDefault: context.flags.default === true,
      env: context.env,
      date: today(),
    });

    const compile = compileLines(result);
    // A repository init just created holds nothing but the plant, so the by-hand command can be the short one.
    const commit =
      result.commit !== null && result.commit.status === "uncommitted" && result.commit.command !== null && result.git === "initialized"
        ? { ...result.commit, command: `git add -A && git commit -m "${PLANT_MESSAGE}"` }
        : result.commit;
    const git =
      result.git === "unavailable"
        ? "git: unavailable, so no repository was initialized; install git and run git init here"
        : `git: ${result.git === "initialized" ? "initialized a repository" : "already a repository"}; ${commit === null ? "" : commitLine(commit, PLANT_MESSAGE).slice("git: ".length)}`;
    const lines = [
      `${standing ? "house" : "planted a house"} at ${result.root}`,
      ...listing("planted", result.planted),
      ...(result.planted.length === 0 ? ["planted: nothing (every file is in place)"] : []),
      ...(result.removed.length === 0 ? [] : [`not planted again (planted once, since removed): ${result.removed.join(", ")}`]),
      git,
      ...compile.lines,
      ...(result.defaultHouse === null ? [] : [result.defaultHouse.changed ? `default_house set in ${result.defaultHouse.path} (seat ledger records the earlier value)` : `default_house already names this house`]),
      `starter jobs proposed, not declared: ${result.proposedJobs.map((job) => job.id).join(", ")}; copy one from ${join(PACKAGE_ROOT, "templates", "jobs")} into house.toml (lampstand run --help shows the shape)`,
    ];
    const actionable = compile.actionable || result.git === "unavailable";
    return {
      ok: !actionable,
      exit: actionable ? 1 : 0,
      data: {
        house: result.root,
        planted: result.planted,
        kept: result.kept,
        removed: result.removed,
        plantedJson: result.plantedJson,
        git: result.git,
        commit: commit?.status === "committed" ? commit.sha : null,
        uncommitted: commit?.status === "uncommitted" ? { reason: commit.reason, command: commit.command } : null,
        compile: result.compile,
        region: result.region,
        defaultHouse: result.defaultHouse,
        proposedJobs: result.proposedJobs,
      },
      text: lines.join("\n"),
    };
  },
};

/** @type {Verb} */
export const upgradeVerb = {
  name: "upgrade",
  summary: "migrate the house to this lampstand: back up, migrate, recompile, commit what changed; an edited planted file gets a proposal",
  flags: WORKSPACE_FLAGS,
  run(context) {
    const found = resolveHouse({ env: context.env, cwd: context.cwd, workspace: !context.flags["no-workspace"] });
    if (found.root === null) throw fail("E_NO_HOUSE", `no house resolved from ${resolve(context.cwd)}`);
    const result = upgradeHouse({ root: found.root, env: context.env, now: new Date(), date: today() });
    const compile = compileLines(result);
    const lines = [
      `upgraded the house at ${result.root}`,
      `backup: ${result.backup}`,
      result.migrations.length === 0 ? "migrations: none needed" : `migrations: ${result.migrations.map((m) => `${m.from} to ${m.to} (${m.summary})`).join("; ")}`,
      ...listing("updated (unedited, replaced)", result.updated),
      ...listing("planted (new in this lampstand)", result.planted),
      ...listing("proposed (edited here, left as they are)", result.proposed),
      ...compile.lines,
      commitLine(result.commit, upgradeMessage()),
    ];
    return {
      ok: !compile.actionable,
      exit: compile.actionable ? 1 : 0,
      data: {
        house: result.root,
        backup: result.backup,
        migrations: result.migrations,
        updated: result.updated,
        planted: result.planted,
        proposed: result.proposed,
        compile: result.compile,
        region: result.region,
        commit: result.commit.status === "committed" ? result.commit.sha : null,
        uncommitted: result.commit.status === "uncommitted" ? { reason: result.commit.reason, command: result.commit.command } : null,
      },
      text: lines.join("\n"),
    };
  },
};

export const verbs = [initVerb, upgradeVerb];
