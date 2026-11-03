// @ts-check
// The one list of every lampstand verb. The CLI entry and every host adapter build their registry from here, so a
// verb added in one place reaches every surface that forwards to it, and none can drift out of step.
import { Registry, versionVerb } from "./cli.js";
import { verbs as constitutionVerbs } from "./constitution/verbs.js";
import { verbs as doctorVerbs } from "./doctor/verbs.js";
import { verbs as governanceVerbs } from "./governance/verbs.js";
import { verbs as initVerbs } from "./init/verbs.js";
import { verbs as orgVerbs } from "./org/verbs.js";
import { verbs as roomsVerbs } from "./rooms/verbs.js";
import { rootVerb } from "./root.js";
import { verbs as seatVerbs } from "./seat/verbs.js";
import { stateVerbs } from "./state/verbs.js";

/** @type {import("./cli.js").Verb[]} */
export const VERBS = [
  versionVerb,
  rootVerb,
  ...stateVerbs,
  ...constitutionVerbs,
  ...governanceVerbs,
  ...orgVerbs,
  ...initVerbs,
  ...seatVerbs,
  ...doctorVerbs,
  ...roomsVerbs,
];

/**
 * A registry of every verb, or of only the named ones (a host's slash command forwards a subset).
 * @param {readonly string[]} [names]
 */
export function registry(names) {
  const chosen = names ? VERBS.filter((verb) => names.includes(verb.name)) : VERBS;
  return new Registry().register(...chosen);
}
