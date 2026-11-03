// @ts-check
// Who a house's sessions sign as in a room. agora resolves the bearer from --as, then AGORA_ACTOR, then the session's
// record, then the shared config's actor.name; the last is a seat-wide default, so a house session posting under it
// would sign as whoever the seat usually is. A house with the rooms module on therefore names itself in AGORA_ACTOR
// for its own sessions, unless the environment already carries one. lampstand only sets a variable in the agent's own
// process; it never writes agora's config.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadHouseConfig } from "../config.js";
import { attempt, expandHome, homeOf } from "../doctor/util.js";
import { stripBom } from "../io.js";

/** @typedef {{ name: string | null, source: "AGORA_ACTOR" | "house name" | "agora actor.name" | "unknown" }} Bearer */

/** The longest segment of an agora bearer. */
const SEGMENT_MAX = 32;

/**
 * The house's name as an agora bearer: letters, digits, `.`, `_` and `-`, starting with a letter or digit and at most
 * 32 characters. Anything else becomes a hyphen; null when nothing is left.
 * @param {string} name
 */
export function bearerFromName(name) {
  const cleaned = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const cut = cleaned.slice(0, SEGMENT_MAX).replace(/[-._]+$/, "");
  return cut === "" ? null : cut;
}

/**
 * The bearer a session in the house at `root` will post as: an explicit AGORA_ACTOR, else the house's name when its
 * rooms module is on, else whatever agora's shared config names. `name` is null when none of them can be read.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd  where agora is run from, for its project-local agora.json
 * @returns {Bearer}
 */
export function bearerFor(root, env, cwd) {
  const explicit = env.AGORA_ACTOR;
  if (explicit !== undefined && explicit.trim() !== "") return { name: explicit.trim(), source: "AGORA_ACTOR" };
  const config = attempt(() => loadHouseConfig(root));
  if ("value" in config && config.value.modules?.rooms === true) {
    const name = bearerFromName(config.value.house.name);
    if (name !== null) return { name, source: "house name" };
  }
  const actor = agoraActorName(env, cwd);
  return actor === null ? { name: null, source: "unknown" } : { name: actor, source: "agora actor.name" };
}

/**
 * agora's shared config actor.name, read the way agora finds the file: AGORA_CONFIG, else agora.json in the working
 * folder, else ~/.agora/config.json. Null when the file is missing or has no name.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 */
function agoraActorName(env, cwd) {
  const home = homeOf(env);
  const local = resolve(cwd, "agora.json");
  const path = env.AGORA_CONFIG ? resolve(expandHome(env.AGORA_CONFIG, home)) : existsSync(local) ? local : join(home, ".agora", "config.json");
  const read = attempt(() => JSON.parse(stripBom(readFileSync(path, "utf8"))));
  const name = "value" in read ? read.value?.actor?.name : undefined;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

/**
 * The value this module last put in an environment's AGORA_ACTOR. A process that serves several houses in turn (a
 * gateway, a session that switches) must be able to replace its own earlier value, and only that, never an actor the
 * operator or the launcher set.
 * @type {string | null}
 */
let ours = null;

/**
 * Names the house in `env.AGORA_ACTOR` for a session in the house at `root`, when its rooms module is on and no
 * AGORA_ACTOR of anyone else's is set. An explicit value is never replaced. A value this function set for another
 * house is replaced, or removed when this house has rooms off. Returns the name set, or null when nothing was.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env  the agent's own environment, changed in place
 * @returns {string | null}
 */
export function markRoomActor(root, env) {
  const present = env.AGORA_ACTOR !== undefined && env.AGORA_ACTOR.trim() !== "";
  if (present && env.AGORA_ACTOR !== ours) return null;
  const config = attempt(() => loadHouseConfig(root));
  const name = "value" in config && config.value.modules?.rooms === true ? bearerFromName(config.value.house.name) : null;
  if (name === null) {
    if (present) delete env.AGORA_ACTOR;
    ours = null;
    return null;
  }
  env.AGORA_ACTOR = name;
  ours = name;
  return name;
}
