// @ts-check
import { join } from "node:path";
import { realHost } from "../scheduler/os.js";
import { seatPath } from "./ledger.js";
import { stateRoot } from "../state/paths.js";
import { describeEntry, seatEntries, seatReset } from "./seat.js";

/** @typedef {import("../cli.js").Verb} Verb */

/** @type {Verb} */
export const seatStatusVerb = {
  name: "seat status",
  summary: "list every write lampstand made outside a house with consent, newest first, as the seat ledger records it",
  run({ env }) {
    const entries = seatEntries(env);
    const path = seatPath(env);
    return {
      data: {
        ledger: path,
        entries: entries.map((entry) => ({ id: entry.id, owner: entry.owner, house: entry.house, kind: entry.kind, target: entry.target, before: entry.before, at: entry.at })),
      },
      text:
        entries.length === 0
          ? `the seat ledger is empty (${path})`
          : [`seat ledger ${path}, newest first:`, ...entries.map((entry) => `  ${entry.at} ${entry.owner}: ${describeEntry(entry)} for ${entry.house}`)].join("\n"),
    };
  },
};

/** @type {Verb} */
export const seatResetVerb = {
  name: "seat reset",
  summary: "reverse every write the seat ledger records, newest first, restoring each earlier value",
  run({ env }) {
    // The scratch dir holds a task definition only while schtasks restores it.
    const { undone, left } = seatReset(realHost(env, join(stateRoot(env), "lampstand", "seat")));
    const lines = undone.length === 0 && left.length === 0 ? ["nothing to reverse: the seat ledger is empty"] : undone.map((line) => `- ${line}`);
    for (const entry of left) lines.push(`left in the ledger, of a kind this lampstand cannot reverse: ${entry.kind} ${entry.target} (${entry.owner})`);
    return {
      ok: left.length === 0,
      exit: left.length === 0 ? 0 : 1,
      data: { undone, left: left.map((entry) => ({ id: entry.id, owner: entry.owner, kind: entry.kind, target: entry.target })) },
      text: lines.join("\n"),
    };
  },
};

export const verbs = [seatStatusVerb, seatResetVerb];
