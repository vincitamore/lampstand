// @ts-check
// `lampstand rooms`, `lampstand rooms enable` and `lampstand rooms status`. Rooms come from agora, a separate package;
// lampstand seeds an example, proposes the rooms provision and checks the setup, and owns no wake code. The operator
// turns the module on in house.toml. While agora is absent nothing rooms-related runs: every verb answers with how to
// install it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { askOnce } from "../cli.js";
import { commitLine, commitOnly } from "../commit.js";
import { loadHouseConfig } from "../config.js";
import { today } from "../constitution/curate.js";
import { fail } from "../errors.js";
import { readText } from "../io.js";
import { fullPath, PLANTED_FILE } from "../init/plant.js";
import { resolveHouse } from "../root.js";
import { commandRunner } from "../doctor/util.js";
import { AGORA_FLOOR, AGORA_INSTALL, agoraExtension, agoraProblemText, detectAgora } from "./agora.js";
import { bearerFor } from "./actor.js";
import { applyEnable, checkExampleRow, planEnable, planIsEmpty, roomsTemplates } from "./house.js";

/** @typedef {import("../cli.js").Verb} Verb */
/** @typedef {import("../cli.js").VerbContext} VerbContext */
/** @typedef {import("../cli.js").VerbResult} VerbResult */
/** @typedef {import("./agora.js").Agora} Agora */
/** @typedef {import("./house.js").EnablePlan} EnablePlan */
/** @typedef {import("./house.js").RoomsTemplates} RoomsTemplates */

const ABOUT = [
  "A room is a shared conversation people and agents post in: a Slack channel, a GitHub issue, a file on this machine.",
  "agora carries the messages and its OMP extension wakes a session when one arrives. lampstand seeds an example room",
  "row, proposes the rule that a room message is input, and checks the setup; it never writes agora's config.",
].join("\n");

/** @param {Agora} agora */
function agoraData(agora) {
  return { path: agora.path, version: agora.version, floor: AGORA_FLOOR, problem: agora.problem };
}

/**
 * The answer every verb gives while agora cannot serve rooms.
 * @param {Agora} agora
 * @param {Record<string, unknown>} [extra]
 * @returns {VerbResult}
 */
function agoraRefusal(agora, extra = {}) {
  return {
    ok: false,
    exit: 1,
    data: { ...extra, agora: agoraData(agora), install: AGORA_INSTALL },
    text: `${agoraProblemText(agora)}.\n${AGORA_INSTALL}`,
  };
}

/** The house a verb acts on, which must exist. @param {VerbContext} context */
function houseRoot({ env, cwd }) {
  const found = resolveHouse({ env, cwd });
  if (found.root === null) throw fail("E_NO_HOUSE", "no house resolved; run inside a house or set HOUSE_ROOT");
  return found.root;
}

/** One line per change a plan makes. @param {EnablePlan} plan */
function describePlan(plan) {
  /** @type {string[]} */
  const out = [];
  for (const rel of plan.plant) out.push(`plant ${rel}`);
  if (plan.provision === "propose") out.push(`propose the rooms provision as ${plan.provisionRel}, for you to adopt or strike`);
  out.push("recompile the projections, which writes only when house.toml changed since the last compile");
  return out;
}

/**
 * The command that adds each example room to agora's own config: lampstand only prints it. The house's copy is shown
 * when it has one, since the operator may have edited it; it was checked before anything was written.
 * @param {string} root
 * @param {RoomsTemplates} templates
 */
function suggestions(root, templates) {
  return templates.rooms.map((room) => {
    const copy = fullPath(root, room.rel);
    const [text, path] = existsSync(copy) ? [readText(copy), copy] : [room.text, room.template];
    const row = JSON.stringify(checkExampleRow(text, path));
    return { alias: room.alias, file: room.rel, command: `agora config room add ${room.alias} '${row}'` };
  });
}

/** @type {Verb} */
export const roomsVerb = {
  name: "rooms",
  summary: "explain rooms, and how to install agora when it is missing",
  run(context) {
    const agora = detectAgora(context.env, commandRunner(context.env));
    const problem = agoraProblemText(agora);
    if (problem !== null) {
      return { data: { agora: agoraData(agora), install: AGORA_INSTALL }, text: `${ABOUT}\n\n${problem}.\n${AGORA_INSTALL}` };
    }
    const next = [
      `agora ${agora.version} (${agora.path}) is at or above ${AGORA_FLOOR}.`,
      `  lampstand rooms enable   once [modules] rooms = true in house.toml: seed rooms/ and propose the rooms provision`,
      "  lampstand rooms status   agora's version and how OMP loads its extension",
    ].join("\n");
    return { data: { agora: agoraData(agora), install: null }, text: `${ABOUT}\n\n${next}` };
  },
};

/** @type {Verb} */
export const roomsEnableVerb = {
  name: "rooms enable",
  summary: "seed rooms/ and propose the rooms provision once [modules] rooms is on (lists the changes, asks once, commits them)",
  flags: { yes: { type: "boolean", summary: "make the listed changes without asking" } },
  run(context) {
    return enableRooms(context, roomsTemplates(), context.flags.yes ? () => true : askOnce);
  },
};

/**
 * @param {VerbContext} context
 * @param {RoomsTemplates} templates
 * @param {(question: string) => boolean | Promise<boolean>} confirm
 * @returns {Promise<VerbResult>}
 */
export async function enableRooms(context, templates, confirm) {
  const agora = detectAgora(context.env, commandRunner(context.env));
  if (agora.problem !== null) return agoraRefusal(agora, { enabled: false, changed: false });
  const root = houseRoot(context);
  if (loadHouseConfig(root).modules?.rooms !== true) {
    return {
      ok: false,
      exit: 1,
      data: { house: root, agora: agoraData(agora), enabled: false, changed: false },
      text: `the rooms module is off: set [modules] rooms = true in ${join(root, "house.toml")}, then run lampstand rooms enable`,
    };
  }
  const plan = planEnable(root, templates);
  const rooms = suggestions(root, templates);
  const next = [
    "To add a room, give its row to agora (lampstand never writes agora's config):",
    ...rooms.map((room) => `  ${room.command}`),
    `${templates.rooms.length > 0 ? "rooms/README.md says what each part means. " : ""}A GitHub issue or GitHub events room needs a wakeFrom list.`,
  ].join("\n");
  const base = { house: root, agora: agoraData(agora), rooms };

  if (planIsEmpty(plan)) {
    return { data: { ...base, enabled: true, changed: false }, text: `rooms are already enabled in ${root}\n${next}` };
  }
  const listing = describePlan(plan).map((line) => `  - ${line}`).join("\n");
  if (!(await confirm(`lampstand rooms enable will, in ${root}:\n${listing}\nMake these changes? [y/N] `))) {
    return { ok: false, exit: 1, data: { ...base, enabled: false, changed: false, plan: describePlan(plan) }, text: "nothing changed" };
  }

  const done = applyEnable(root, templates, plan, today());
  /** @type {string[]} */
  const lines = [];
  for (const rel of done.seeded) lines.push(`planted ${rel}`);
  if (done.proposed !== null) lines.push(`proposed ${done.proposed}: adopt it with lampstand adopt`);
  if (done.proposalRefused !== null) lines.push(`provision not proposed: ${done.proposalRefused}`);
  // Exactly what enabling wrote: the seeded examples, planted.json, the proposal and any recompiled projection.
  const message = "Enable rooms";
  const commit = commitOnly(root, [...done.seeded, ...(done.seeded.length > 0 ? [PLANTED_FILE] : []), ...(done.proposed === null ? [] : [done.proposed]), ...done.compile.written], message, context.env);
  const refused = done.compile.errors.length > 0;
  if (refused) lines.push(`compile refused, projections unchanged; run lampstand compile:\n${done.compile.errors.map((line) => `  ${line}`).join("\n")}`);
  else if (done.compile.written.length > 0) lines.push(`recompiled (${done.compile.written.length} files written)`);
  lines.push(commitLine(commit, message));
  return {
    ok: !refused,
    exit: refused ? 1 : 0,
    data: {
      ...base,
      enabled: true,
      changed: true,
      ...done,
      commit: commit.status === "committed" ? commit.sha : null,
      uncommitted: commit.status === "uncommitted" ? { reason: commit.reason, command: commit.command } : null,
    },
    text: `${lines.join("\n")}\n${next}`,
  };
}

/** @type {Verb} */
export const roomsStatusVerb = {
  name: "rooms status",
  summary: "agora's version, whether OMP loads its extension as a plugin or by path, whether it loads twice, and who room posts sign as",
  run(context) {
    const agora = detectAgora(context.env, commandRunner(context.env));
    const found = resolveHouse({ env: context.env, cwd: context.cwd });
    const house = found.root === null ? null : { root: found.root, rooms: loadHouseConfig(found.root).modules?.rooms === true };
    if (agora.problem === "AGORA_MISSING") return agoraRefusal(agora, { extension: null, house });

    const bearer = house === null ? null : bearerFor(house.root, context.env, context.cwd);
    const extension = agoraExtension(context.env, context.cwd);
    const problem = agoraProblemText(agora);
    const how = extension.loads.length === 0
      ? "not loaded by OMP"
      : extension.loads.map((load) => `${load.kind === "plugin" ? "an OMP plugin" : "a path"}: ${load.path} (${load.source})`).join("\n  ");
    const lines = [
      problem === null ? `agora ${agora.version} (${agora.path}), at or above ${AGORA_FLOOR}` : `${problem}.\n${AGORA_INSTALL}`,
      `OMP extension: ${extension.loads.length > 1 ? "\n  " : ""}${how}`,
      extension.twice
        ? "loaded twice: yes; OMP runs each copy, so every room message arrives twice. Keep one: the plugin install or the extensions entry."
        : "loaded twice: no",
      ...extension.unreadable.map((failure) => `not read: ${failure.message}`),
      house === null ? "house: none here" : `house: ${house.root}, [modules] rooms = ${house.rooms}`,
      ...(bearer === null ? [] : [bearer.name === null ? "room posts sign as: unknown (agora's config names no actor)" : `room posts sign as: ${bearer.name} (${bearer.source})`]),
    ];
    const bad = problem !== null || extension.twice;
    return {
      ok: !bad,
      exit: bad ? 1 : 0,
      data: { agora: agoraData(agora), extension, house, bearer, install: problem === null ? null : AGORA_INSTALL },
      text: lines.join("\n"),
    };
  },
};

export const verbs = [roomsVerb, roomsEnableVerb, roomsStatusVerb];
