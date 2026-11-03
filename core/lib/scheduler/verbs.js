// @ts-check
// `lampstand tick` and `lampstand scheduler enable|disable|status`. The enable/disable/status logic takes its host
// (platform, command runner, home) as a parameter, so tests drive it with a recorder instead of the real scheduler.
import { join } from "node:path";
import { askOnce } from "../cli.js";
import { fail } from "../errors.js";
import { loadHouse } from "../governance/jobs.js";
import { WORKSPACE_FLAGS, resolveHouse } from "../root.js";
import { stateDirFor } from "../state/paths.js";
import { apply, plan, probe, realHost, recorded, revert, tickArgv, tickKey } from "./os.js";
import { tick } from "./tick.js";

/** @typedef {import("../cli.js").Verb} Verb */
/** @typedef {import("../cli.js").VerbContext} VerbContext */
/** @typedef {import("../cli.js").VerbResult} VerbResult */
/** @typedef {import("../governance/jobs.js").House} House */
/** @typedef {import("./os.js").Host} Host */

/**
 * The house a verb acts on. `--house <dir>` names it the way HOUSE_ROOT does, for OS entries that cannot set
 * variables or a working directory.
 * @param {VerbContext} context
 */
export function houseFor({ env, cwd, flags }) {
  const named = typeof flags.house === "string" ? flags.house : undefined;
  const found = resolveHouse({ env: named ? { ...env, HOUSE_ROOT: named } : env, cwd, workspace: !flags["no-workspace"] });
  if (found.root === null) throw fail("E_NO_HOUSE", "no house resolved; run inside a house, set HOUSE_ROOT, or pass --house");
  return loadHouse(found.root);
}

const HOUSE_FLAG = /** @type {const} */ ({
  house: { type: "string", summary: "the house to act on, as HOUSE_ROOT would name it" },
  ...WORKSPACE_FLAGS,
});

/** @type {Verb} */
export const tickVerb = {
  name: "tick",
  summary: "run due jobs and doctor --quick; silent on success, one capture per distinct failure",
  flags: HOUSE_FLAG,
  async run(context) {
    const house = houseFor(context);
    const result = await tick({ house, env: context.env });
    const data = {
      house: house.root,
      active: result.active,
      ran: result.ran.map((record) => ({ job: record.job, run_id: record.runId, outcome: record.outcome })),
      doctor: result.doctor,
      failures: result.failures,
      capture: result.capture,
    };
    if (result.failures.length === 0) return { data, text: "" };
    const note = result.capture ? `capture: ${result.capture}` : "same failure as the previous tick; no new capture";
    return { ok: false, exit: 1, data, text: [...result.failures, note].join("\n") };
  },
};

/** @param {House} house @param {NodeJS.ProcessEnv} env */
function hostFor(house, env) {
  return realHost(env, join(stateDirFor(house.root, house.config.house.id, env).dir, "scheduler"));
}

/** @param {House} house */
function moduleOff(house) {
  return house.config.modules?.scheduler !== true;
}

/**
 * Lists every OS entry it will create, asks once, then creates them, recording each in the seat ledger.
 * @param {{ house: House, host: Host, confirm: (question: string) => boolean | Promise<boolean> }} options
 * @returns {Promise<VerbResult>}
 */
export async function enableScheduler({ house, host, confirm }) {
  const key = tickKey(house.root, house.config.house.id);
  if (moduleOff(house)) {
    return {
      ok: false,
      exit: 1,
      data: { house: house.root, key, enabled: false, changed: false },
      text: `the scheduler module is off: set [modules] scheduler = true in ${house.path}, then run lampstand scheduler enable`,
    };
  }
  if (recorded(host.env, key).length > 0) {
    const { method, registered } = probe(host, key);
    return {
      data: { house: house.root, key, method, enabled: true, registered, changed: false },
      text: `already enabled (${method}${registered ? "" : ", but the OS no longer carries it: run lampstand scheduler disable, then enable"})`,
    };
  }
  const chosen = plan(host, key, tickArgv(house.root));
  const listing = chosen.describe.map((line) => `  - ${line}`).join("\n");
  const question = `lampstand scheduler enable will create, as the current user:\n${listing}\nEach is recorded in the seat ledger so disable restores what was there.\nCreate them? [y/N] `;
  if (!(await confirm(question))) {
    return {
      ok: false,
      exit: 1,
      data: { house: house.root, key, method: chosen.method, enabled: false, changed: false, entries: chosen.describe },
      text: "nothing created",
    };
  }
  apply(host, chosen, house.root);
  return {
    data: { house: house.root, key, method: chosen.method, enabled: true, changed: true, entries: chosen.describe },
    text: `created:\n${listing}`,
  };
}

/**
 * Reverses every entry `enable` recorded for this house.
 * @param {{ house: House, host: Host }} options
 * @returns {VerbResult}
 */
export function disableScheduler({ house, host }) {
  const key = tickKey(house.root, house.config.house.id);
  if (recorded(host.env, key).length === 0) {
    return { data: { house: house.root, key, enabled: false, changed: false, undone: [] }, text: "not enabled; nothing to remove" };
  }
  const undone = revert(host, key);
  return {
    data: { house: house.root, key, enabled: false, changed: true, undone },
    text: undone.map((line) => `- ${line}`).join("\n"),
  };
}

/**
 * The ledger's view and the OS's view of this house's entry. They disagreeing is an actionable finding.
 * @param {{ house: House, host: Host }} options
 * @returns {VerbResult}
 */
export function schedulerStatus({ house, host }) {
  const key = tickKey(house.root, house.config.house.id);
  const entries = recorded(host.env, key);
  const { method, registered } = probe(host, key);
  const enabled = entries.length > 0;
  const agree = enabled === registered;
  const state = enabled ? (registered ? "enabled" : "recorded in the seat ledger but missing from the OS") : registered ? "registered with the OS but not in the seat ledger" : "not enabled";
  return {
    ok: agree,
    exit: agree ? 0 : 1,
    data: {
      house: house.root,
      key,
      module: !moduleOff(house),
      method,
      enabled,
      registered,
      entries: entries.map((entry) => ({ kind: entry.kind, target: entry.target })),
    },
    text: [`${state} (${method}, ${key})`, `scheduler module: ${moduleOff(house) ? "off" : "on"}`].join("\n"),
  };
}

/** @type {Verb} */
export const schedulerEnableVerb = {
  name: "scheduler enable",
  summary: "register this house's one OS scheduler entry (lists it and asks once)",
  flags: { yes: { type: "boolean", summary: "create the listed entries without asking (for CI)" }, ...HOUSE_FLAG },
  run(context) {
    const house = houseFor(context);
    const confirm = context.flags.yes ? () => true : askOnce;
    return enableScheduler({ house, host: hostFor(house, context.env), confirm });
  },
};

/** @type {Verb} */
export const schedulerDisableVerb = {
  name: "scheduler disable",
  summary: "remove this house's OS scheduler entry, restoring what the seat ledger recorded",
  flags: HOUSE_FLAG,
  run(context) {
    const house = houseFor(context);
    return disableScheduler({ house, host: hostFor(house, context.env) });
  },
};

/** @type {Verb} */
export const schedulerStatusVerb = {
  name: "scheduler status",
  summary: "show whether this house's OS scheduler entry is recorded and registered",
  flags: HOUSE_FLAG,
  run(context) {
    const house = houseFor(context);
    return schedulerStatus({ house, host: hostFor(house, context.env) });
  },
};

export const verbs = [tickVerb, schedulerEnableVerb, schedulerDisableVerb, schedulerStatusVerb];
