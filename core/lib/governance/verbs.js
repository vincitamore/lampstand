// @ts-check
import { houseFor, verbs as schedulerVerbs } from "../scheduler/verbs.js";
import { fail } from "../errors.js";
import { WORKSPACE_FLAGS } from "../root.js";
import { jobHealth } from "./health.js";
import { openHouseDb, runJob } from "./run.js";

/** @type {import("../cli.js").Verb} */
export const runVerb = {
  name: "run",
  summary: "run one declared job under write governance, or report each job's health with --status",
  flags: {
    status: { type: "boolean", summary: "report each job's last landed outcome against stale_hours instead of running" },
    ...WORKSPACE_FLAGS,
  },
  args: { min: 0, max: 1, usage: "<job>" },
  run(context) {
    const house = houseFor(context);
    if (context.flags.status) {
      const ids = context.args.length > 0 ? context.args : [...house.jobs.keys()].sort();
      const unknown = ids.find((id) => !house.jobs.has(id));
      if (unknown !== undefined) throw fail("E_USAGE", `no job ${JSON.stringify(unknown)} in [jobs]`, { path: house.path });
      const state = openHouseDb(house, context.env);
      let jobs;
      try {
        const now = Date.now();
        jobs = ids.map((id) => jobHealth(state.db, /** @type {import("./jobs.js").Job} */ (house.jobs.get(id)), now));
      } finally {
        state.db.close();
      }
      const healthy = jobs.every((job) => job.health === "OK");
      const width = Math.max(0, ...jobs.map((job) => job.job.length));
      const lines = jobs.map((job) => {
        const when = job.last_landed_at ? `last landed ${job.last_landed_at}` : "never landed";
        return `${job.health.padEnd(10)} ${job.job.padEnd(width)}  ${when}; stale after ${job.stale_hours}h${job.detail ? `; ${job.detail}` : ""}`;
      });
      return {
        ok: healthy,
        exit: healthy ? 0 : 1,
        data: { house: house.root, jobs },
        text: lines.length > 0 ? lines.join("\n") : "no jobs declared in house.toml [jobs]",
      };
    }
    if (context.args.length === 0) throw fail("E_USAGE", "lampstand run needs <job>, or --status");
    const record = runJob({ house, jobId: context.args[0], env: context.env });
    const good = record.outcome === "landed" || record.outcome === "skipped";
    return {
      ok: good,
      exit: good ? 0 : 1,
      data: {
        job: record.job,
        run_id: record.runId,
        outcome: record.outcome,
        exit_code: record.exitCode,
        landed: record.landed,
        commit: record.commit,
        detail: record.detail,
        log: record.log,
      },
      text: `${record.job}: ${record.outcome}${record.detail ? `: ${record.detail}` : ""}`,
    };
  },
};

/** The run, tick and scheduler verbs, registered by core/bin/lampstand.js. @type {import("../cli.js").Verb[]} */
export const verbs = [runVerb, ...schedulerVerbs];
