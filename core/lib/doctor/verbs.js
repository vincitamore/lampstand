// @ts-check
// `lampstand doctor [--quick] [--json]`: gathers the facts once, runs every check over them and exits with the most
// severe finding's class (0 healthy, 1 fixable by a re-run, compile, upgrade or restart, 2 a person must act, 3 no
// house here or setup unfinished). With --json stdout is `{ ok, exit, findings: [{ code, area, level, message, fix }] }`.
import { WORKSPACE_FLAGS } from "../root.js";
import { CHECKS, runChecks } from "./checks.js";
import { gatherFacts } from "./facts.js";

/** @typedef {import("../cli.js").Verb} Verb */
/** @typedef {import("../cli.js").VerbResult} VerbResult */
/** @typedef {import("./checks.js").Finding} Finding */

const MEANING = Object.freeze({
  0: "healthy",
  1: "broken; a re-run, lampstand compile, lampstand upgrade or a restart fixes it",
  2: "broken; a person must act",
  3: "no house here, or setup unfinished",
});

/**
 * The text report: the most severe finding first, so its first line names what decides the exit (the scheduler's
 * tick quotes that line in its capture).
 * @param {{ exit: 0 | 1 | 2 | 3, findings: Finding[], ran: string[] }} report
 */
function render(report) {
  const lines = report.findings.flatMap((finding) => [
    `${finding.level} [${finding.code}] ${finding.area}: ${finding.message}`,
    ...(finding.fix === "" ? [] : [`  fix: ${finding.fix}`]),
  ]);
  lines.push(`doctor: exit ${report.exit}, ${MEANING[report.exit]} (${report.ran.length} of ${CHECKS.length} checks run)`);
  return lines.join("\n");
}

/** @type {Verb} */
export const doctorVerb = {
  name: "doctor",
  summary: "check the house, its state, OMP, Hermes and rooms for objective faults; exit 0 healthy, 1 fixable, 2 a person must act, 3 no house",
  flags: {
    quick: { type: "boolean", summary: "only the core checks that need no network and no host process" },
    ...WORKSPACE_FLAGS,
  },
  run({ env, cwd, flags }) {
    const quick = flags.quick === true;
    const facts = gatherFacts({ env, cwd, quick, workspace: !flags["no-workspace"] });
    const report = runChecks(facts, { quick });
    return {
      ok: report.exit === 0,
      exit: report.exit,
      data: { exit: report.exit, findings: report.findings },
      text: render(report),
    };
  },
};

export const verbs = [doctorVerb];
