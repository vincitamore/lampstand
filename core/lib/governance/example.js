// @ts-check
// The shape of a job declaration, shown by `lampstand run --help` and `lampstand scheduler --help`. The example is
// parsed by the real loader in the tests, so the help cannot drift from what house.toml accepts.

/** A minimal job, as it is written in house.toml. */
export const JOB_EXAMPLE = [
  "[modules]",
  "scheduler = true            # required for `lampstand scheduler enable`; `lampstand run` works without it",
  "",
  "[jobs.nightly-report]       # the id: lowercase letters, digits and hyphens, starting with a letter",
  'argv = ["node", "scripts/report.js"]   # the program and its arguments; "lampstand" names this CLI',
  'at = "02:30"                # when it runs: every = "6h" (m, h or d), at = "HH:MM" daily, or cron = "m h dom mon dow";',
  "                            # at most one of the three, none means by hand only",
  "stale_hours = 36            # how long without a landed run before health reports it STALE",
  'outputs = ["state/reports/"]  # prefixes it may create new files under',
  'mutates = ["state/current.md"]  # existing files it may replace',
  "commit = true               # false (default), true, or \"push\": commit what landed, only those paths",
].join("\n");

/** Help text for the verbs that run jobs. */
export function jobHelp() {
  return [
    "Jobs are declared in house.toml, one [jobs.<id>] table each:",
    "",
    ...JOB_EXAMPLE.split("\n").map((line) => `  ${line}`),
    "",
    "Required: argv and stale_hours. Optional: every | at | cron, outputs, mutates, commit, cost_ceiling_usd, env (the",
    "names of environment variables the job inherits).",
    "",
    "A job runs in the house folder with HOUSE_ROOT, HOUSE_RUN_OUT (a staging folder) and HOUSE_RUN_ID set. It writes its",
    "files under HOUSE_RUN_OUT at their house-relative paths; only paths under outputs, or exactly in mutates, land in the",
    "house, and one path outside them rejects the whole run. `lampstand run <job>` runs one by hand; `lampstand scheduler",
    "enable` registers the one OS entry that runs whatever is due (needs [modules] scheduler = true).",
  ].join("\n");
}
