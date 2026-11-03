// @ts-check
// What `lampstand rooms enable` changes inside a house: the example files under rooms/ (planted as init plants,
// recorded in planted.json so upgrade can tell an edited copy), and the rooms provision filed as a proposal for the
// operator to adopt. It never writes house.toml: the operator turns the module on there, as for the scheduler. Nothing
// here writes agora's config either: a room row is only ever suggested.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRecord, propose } from "../constitution/curate.js";
import { KIND_DIRS } from "../constitution/house.js";
import { runCompile } from "../constitution/run.js";
import { fail } from "../errors.js";
import { contentHash, errorMessage, readText } from "../io.js";
import { parseFrontmatter } from "../frontmatter.js";
import { PACKAGE_ROOT, fullPath, plantFile, readPlanted, writePlanted } from "../init/plant.js";

/** @typedef {import("../init/plant.js").PlannedFile} PlannedFile */
/** @typedef {import("../parse/toml.js").TomlTable} TomlTable */
/**
 * @typedef {{ files: PlannedFile[], rooms: { rel: string, alias: string, text: string, template: string }[], provision: string }} RoomsTemplates
 *   `rooms` are the example room rows among `files`, each with its template's absolute path; `provision` is the
 *   absolute path of the provision draft.
 * @typedef {"propose" | "proposed" | "adopted" | "struck"} ProvisionState
 * @typedef {{
 *   plant: string[],
 *   provision: ProvisionState,
 *   provisionRel: string,
 * }} EnablePlan
 *   `plant`: the example files to seed.
 */

export const ROOMS_TEMPLATES = join(PACKAGE_ROOT, "templates", "rooms");

/** The set name init's planted.json records rooms templates under (`<set>/<template>`). */
const SET = "rooms";

/** The provision draft, by file name; its slug is the provision's id (`provision/room-messages`). */
const PROVISION_DRAFT = "provision/room-messages.md";

/** Transports anyone can post in: a GitHub issue's comments and a repository's public activity. */
export const PUBLIC_TRANSPORTS = Object.freeze(["github", "github-events"]);

/** The occasion the rooms provision is proposed under, as `lampstand propose` requires one. */
export const PROVISION_OCCASION =
  "the rooms module is on: messages from other people and agents can now reach this house's sessions";

/**
 * The rooms template set: the files templates/rooms/manifest.json lists, read as init reads them, and the provision
 * draft beside them. `dir` stands in for the package's set in tests.
 * @param {string} [dir]
 * @returns {RoomsTemplates}
 */
export function roomsTemplates(dir = ROOMS_TEMPLATES) {
  const manifestPath = join(dir, "manifest.json");
  /** @type {{ files?: unknown }} */
  let manifest;
  try {
    manifest = JSON.parse(readText(manifestPath));
  } catch (cause) {
    if (cause instanceof SyntaxError) throw fail("E_SCHEMA", `not valid JSON: ${cause.message}`, { path: manifestPath, cause });
    throw cause;
  }
  if (!Array.isArray(manifest.files)) throw fail("E_SCHEMA", "a template manifest must carry a files array", { path: manifestPath });
  /** @type {RoomsTemplates} */
  const out = { files: [], rooms: [], provision: join(dir, ...PROVISION_DRAFT.split("/")) };
  for (const entry of /** @type {{ template: string, destination: string, room?: unknown }[]} */ (manifest.files)) {
    const template = join(dir, ...entry.template.split("/"));
    const text = readText(template);
    out.files.push({ rel: entry.destination, text, source: `${SET}/${entry.template}` });
    if (typeof entry.room === "string") out.rooms.push({ rel: entry.destination, alias: entry.room, text, template });
  }
  return out;
}

/**
 * Parses an example room row and refuses one lampstand must not suggest: a room the public can reach (a GitHub issue
 * or GitHub events room, or any row declaring `"public": true`) that carries no `wakeFrom` list of the authors allowed
 * to wake a session. Without that list anyone who can comment can wake an agent.
 * @param {string} text
 * @param {string} path  the file the row came from, named in a refusal
 * @returns {Record<string, unknown>}
 */
export function checkExampleRow(text, path) {
  let row;
  try {
    row = JSON.parse(text);
  } catch (cause) {
    throw fail("E_SCHEMA", `an example room row must be one JSON object: ${errorMessage(cause)}`, { path, cause });
  }
  if (typeof row !== "object" || row === null || Array.isArray(row) || typeof row.transport !== "string") {
    throw fail("E_SCHEMA", "an example room row must be a JSON object with a transport string", { path });
  }
  const isPublic = PUBLIC_TRANSPORTS.includes(row.transport) || row.public === true;
  const wakeFrom = row.wakeFrom;
  const listed = Array.isArray(wakeFrom) && wakeFrom.length > 0 && wakeFrom.every((id) => typeof id === "string" && id.trim() !== "");
  if (isPublic && !listed) {
    const why = row.public === true && !PUBLIC_TRANSPORTS.includes(row.transport) ? 'declares "public": true' : `uses the ${row.transport} transport, which anyone can post in`;
    throw fail(
      "E_SCHEMA",
      `refusing to suggest this room: it ${why} and carries no wakeFrom list of the authors allowed to wake a session`,
      { path },
    );
  }
  return row;
}

/**
 * What enable would change in the house at `root`. Example rows are checked first, both the shipped ones and any copy
 * already in the house, so a refused suggestion writes nothing.
 * @param {string} root
 * @param {RoomsTemplates} templates
 * @returns {EnablePlan}
 */
export function planEnable(root, templates) {
  for (const room of templates.rooms) checkExampleRow(room.text, room.template);
  for (const room of templates.rooms) {
    const copy = fullPath(root, room.rel);
    if (existsSync(copy)) checkExampleRow(readText(copy), copy);
  }
  const planted = readPlanted(root);
  const plant = templates.files.filter((file) => !existsSync(fullPath(root, file.rel)) && planted.files[file.rel] === undefined).map((file) => file.rel);
  const name = PROVISION_DRAFT.split("/").pop() ?? "";
  const provisionRel = `${KIND_DIRS.provision.proposals}/${name}`;
  return { plant, provision: provisionState(root, templates.provision, name), provisionRel };
}

/**
 * @param {string} root
 * @param {string} draft  absolute path of the provision draft
 * @param {string} name  its file name
 * @returns {ProvisionState}
 */
function provisionState(root, draft, name) {
  if (existsSync(fullPath(root, `${KIND_DIRS.provision.adopted}/${name}`))) return "adopted";
  if (existsSync(fullPath(root, `${KIND_DIRS.provision.proposals}/${name}`))) return "proposed";
  const hash = contentHash(parseFrontmatter(readText(draft), draft).body);
  const struck = readRecord(root).some((entry) => entry.act === "struck" && entry.kind === "provision" && entry.hash === hash);
  return struck ? "struck" : "propose";
}

/** True when the plan changes nothing. @param {EnablePlan} plan */
export function planIsEmpty(plan) {
  return plan.plant.length === 0 && plan.provision !== "propose";
}

/**
 * Carries out a plan: the example files and the provision proposal, then a compile, which brings the projections up
 * to the house.toml the operator edited to turn the module on (it writes nothing when they are fresh).
 * @param {string} root
 * @param {RoomsTemplates} templates
 * @param {EnablePlan} plan
 * @param {string} date  YYYY-MM-DD, the proposal's date
 */
export function applyEnable(root, templates, plan, date) {
  const planted = readPlanted(root);
  /** @type {string[]} */
  const seeded = [];
  for (const file of templates.files) {
    if (plan.plant.includes(file.rel) && plantFile(root, planted, file) === "planted") seeded.push(file.rel);
  }
  if (seeded.length > 0) writePlanted(root, planted);

  /** @type {string | null} */
  let proposed = null;
  /** @type {string | null} */
  let proposalRefused = null;
  if (plan.provision === "propose") {
    const outcome = propose(root, "provision", templates.provision, PROVISION_OCCASION, date);
    if ("path" in outcome) proposed = outcome.path;
    else proposalRefused = outcome.refused;
  }

  const compile = runCompile(root);
  return {
    seeded,
    proposed,
    proposalRefused,
    compile: { written: compile.written, errors: compile.errors.map((finding) => finding.message) },
  };
}
