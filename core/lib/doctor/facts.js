// @ts-check
// Everything doctor looks at, gathered in one place so every check is a pure function of the value returned here.
// Gathering never judges: a file that cannot be read becomes a `failure` in the facts, and a check decides what it
// means. Host facts (OMP, Hermes, rooms) live in hosts.js and are gathered only outside --quick, because they may
// start host processes.
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isLampstandError } from "../errors.js";
import { errorMessage, normalizeLf, stripBom } from "../io.js";
import { resolveHouse } from "../root.js";
import { loadHouse as loadJobsHouse } from "../governance/jobs.js";
import { jobHealth } from "../governance/health.js";
import { inputHash, KIND_DIRS, loadHouse as loadConstitution, markdownFiles, readInputs } from "../constitution/house.js";
import { compileHouse, MANIFEST_FILE, readHeader } from "../constitution/compile.js";
import { readGenerated } from "../constitution/run.js";
import { agentsRegionStale } from "../init/region.js";
import { PLANTED_FILE, UPDATES_DIR } from "../init/plant.js";
import { stateDirFor } from "../state/paths.js";
import { Database } from "../state/sqlite.js";
import { probe, realHost, recorded, tickKey } from "../scheduler/os.js";
import { gatherHosts } from "./hosts.js";
import { attempt, commandRunner, isFile, isWithin, which } from "./util.js";

/** @typedef {import("../governance/health.js").JobHealth} JobHealth */
/** @typedef {import("../scheduler/os.js").Host} SchedulerHost */
/** @typedef {import("./hosts.js").HostFacts} HostFacts */
/** @typedef {import("./util.js").Failure} Failure */
/** @typedef {import("./util.js").Runner} Runner */
/**
 * @typedef {{
 *   ok: true,
 *   schema: number,
 *   pluginMin: string | null,
 *   id: string,
 *   modules: { scheduler: boolean, rooms: boolean },
 * } | { ok: false, failure: Failure }} ConfigFacts
 * @typedef {{
 *   ok: true,
 *   expected: string[],
 *   surfaces: Record<string, { chars: number, cap: number }>,
 *   regionStale: boolean,
 * } | { ok: false, failure: Failure }} ConstitutionFacts
 * @typedef {{
 *   inputHash: string | Failure,
 *   files: { name: string, inputHash: string | null }[] | Failure,
 * }} GeneratedFacts
 * @typedef {{ point: string, type: string }} Mount
 * @typedef {{
 *   dir: string,
 *   source: "default" | "config",
 *   mount: Mount | null,
 *   syncRoots: string[],
 * } | { failure: Failure }} StateDirFacts
 * @typedef {{ path: string, exists: boolean, version: number | null, failure: Failure | null }} StateDbFacts
 * @typedef {{
 *   key: string,
 *   method: string,
 *   registered: boolean,
 *   ledgerHouses: string[],
 *   definition: string | null,
 * } | { key: string, failure: Failure }} TickFacts
 * @typedef {{ health: JobHealth[], tick: TickFacts | null }} JobFacts
 * @typedef {{
 *   root: string,
 *   planted: boolean,
 *   config: ConfigFacts,
 *   constitution: ConstitutionFacts | null,
 *   generated: GeneratedFacts | null,
 *   stateDir: StateDirFacts | null,
 *   stateDb: StateDbFacts | null,
 *   jobs: JobFacts | null,
 *   proposals: string[],
 * }} HouseFacts
 * @typedef {{
 *   platform: NodeJS.Platform,
 *   cwd: string,
 *   houseRootEnv: string | null,
 *   resolution: { root: string, rule: string } | { root: null, failure: Failure | null },
 *   walkUp: string | null,
 *   house: HouseFacts | null,
 *   path: { node: string | null, bun: string | null, git: string | null },
 *   hosts: HostFacts | null,
 * }} Facts
 */

/** Environment variables naming folders a sync client mirrors; a database inside one is copied mid-write. */
const SYNC_ROOT_VARIABLES = Object.freeze(["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]);

/**
 * The mount holding `path` from /proc/self/mounts (Linux), or null where the table does not exist.
 * @param {string} path
 */
function mountOf(path) {
  if (process.platform !== "linux") return null;
  let text;
  try {
    text = readFileSync("/proc/self/mounts", "utf8");
  } catch {
    return null;
  }
  /** @type {Mount | null} */
  let best = null;
  for (const line of text.split("\n")) {
    const [, point, type] = line.split(" ");
    if (point === undefined || type === undefined) continue;
    // The kernel writes space, tab, newline and backslash in mount points as three-digit octal escapes.
    const decoded = point.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (isWithin(path, decoded) && (best === null || decoded.length > best.point.length)) best = { point: decoded, type };
  }
  return best;
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   cwd: string,
 *   quick: boolean,
 *   workspace?: boolean,
 *   now?: number,
 *   run?: Runner,
 *   schedulerHost?: SchedulerHost,
 * }} options
 *   `run` starts host processes (`omp --version`, `agora --version`); `schedulerHost` asks the OS scheduler about the
 *   tick entry. Tests substitute both.
 * @returns {Facts}
 */
export function gatherFacts(options) {
  const { env, quick } = options;
  const cwd = resolve(options.cwd);
  const now = options.now ?? Date.now();
  const houseRootEnv = env.HOUSE_ROOT ? env.HOUSE_ROOT : null;

  /** @type {Facts["resolution"]} */
  let resolution;
  const found = attempt(() => resolveHouse({ env, cwd, workspace: options.workspace ?? true }));
  if ("failure" in found) resolution = { root: null, failure: found.failure };
  else if (found.value.root === null) resolution = { root: null, failure: null };
  else resolution = { root: found.value.root, rule: found.value.rule };

  let walkUp = null;
  if (houseRootEnv !== null) {
    const walked = attempt(() => resolveHouse({ env: { ...env, HOUSE_ROOT: "" }, cwd }));
    if ("value" in walked) walkUp = walked.value.root;
  }

  const house = resolution.root === null ? null : gatherHouse(resolution.root, env, now, options.schedulerHost, quick);
  const run = options.run ?? commandRunner(env);
  return {
    platform: process.platform,
    cwd,
    houseRootEnv,
    resolution,
    walkUp,
    house,
    path: { node: which("node", env), bun: which("bun", env), git: which("git", env) },
    hosts: quick ? null : gatherHosts({ env, cwd, house, run }),
  };
}

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {number} now
 * @param {SchedulerHost | undefined} schedulerHost
 * @param {boolean} quick  the OS scheduler is a host process, so --quick never asks it
 * @returns {HouseFacts}
 */
function gatherHouse(root, env, now, schedulerHost, quick) {
  const planted = isFile(join(root, ...PLANTED_FILE.split("/")));
  const proposals = [...Object.values(KIND_DIRS).map((dirs) => dirs.proposals), UPDATES_DIR].flatMap((dir) => markdownFiles(root, dir));
  const loaded = attempt(() => loadJobsHouse(root));
  if ("failure" in loaded) {
    return { root, planted, config: { ok: false, failure: loaded.failure }, constitution: null, generated: null, stateDir: null, stateDb: null, jobs: null, proposals };
  }
  const house = loaded.value;
  const config = house.config;
  /** @type {ConfigFacts} */
  const configFacts = {
    ok: true,
    schema: config.house.schema,
    pluginMin: config.plugin?.min ?? null,
    id: config.house.id,
    modules: { scheduler: config.modules?.scheduler === true, rooms: config.modules?.rooms === true },
  };

  /** @type {ConstitutionFacts} */
  let constitution;
  const compiled = attempt(() => {
    const result = compileHouse(loadConstitution(root));
    return { result, regionStale: agentsRegionStale(root, result) };
  });
  if ("failure" in compiled) {
    constitution = { ok: false, failure: compiled.failure };
  } else {
    const { result, regionStale } = compiled.value;
    constitution = {
      ok: true,
      expected: result.files.map((file) => file.name),
      surfaces: Object.fromEntries(Object.entries(result.manifest.surfaces).map(([key, size]) => [key, { chars: size.chars, cap: size.cap }])),
      regionStale,
    };
  }

  const current = attempt(() => inputHash(readInputs(root)));
  const onDisk = attempt(() => readGenerated(root));
  /** @type {GeneratedFacts} */
  const generated = {
    inputHash: "failure" in current ? current.failure : current.value,
    files: "failure" in onDisk ? onDisk.failure : [...onDisk.value].map(([name, text]) => ({ name, inputHash: recordedHash(name, text) })),
  };

  /** @type {StateDirFacts} */
  let stateDir;
  /** @type {StateDbFacts | null} */
  let stateDb = null;
  const located = attempt(() => stateDirFor(root, config.house.id, env));
  if ("failure" in located) {
    stateDir = { failure: located.failure };
  } else {
    const { dir, source } = located.value;
    const syncRoots = SYNC_ROOT_VARIABLES.map((name) => env[name] ?? "").filter((value) => value !== "" && isAbsolute(value));
    stateDir = { dir, source, mount: mountOf(dir), syncRoots };
    stateDb = readStateDb(join(dir, "house.db"));
  }

  /** @type {JobFacts | null} */
  let jobs = null;
  if (configFacts.modules.scheduler) {
    const scheduled = [...house.jobs.values()].filter((job) => job.schedule !== null).sort((a, b) => (a.id < b.id ? -1 : 1));
    const dir = "dir" in stateDir ? stateDir.dir : null;
    const health = jobsHealth(stateDb, scheduled, now);
    const host = schedulerHost ?? realHost(env, dir === null ? tmpdir() : join(dir, "scheduler"));
    jobs = { health, tick: quick ? null : tickFacts(host, root, config.house.id) };
  }

  return { root, planted, config: configFacts, constitution, generated, stateDir, stateDb, jobs, proposals };
}

/**
 * The input hash a generated file records: the header of a projection, the `input-hash` of the manifest; null when
 * the file carries none.
 * @param {string} name
 * @param {string} text
 */
function recordedHash(name, text) {
  if (name === MANIFEST_FILE) {
    try {
      const value = JSON.parse(text)?.["input-hash"];
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  return readHeader(normalizeLf(stripBom(text)))?.inputHash ?? null;
}

/**
 * Reads house.db's schema version without migrating it: doctor never writes the state it is judging.
 * @param {string} path
 * @returns {StateDbFacts}
 */
function readStateDb(path) {
  if (!existsSync(path)) return { path, exists: false, version: null, failure: null };
  /** @type {Database | undefined} */
  let db;
  try {
    db = new Database(path);
    const hasMeta = db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'") !== undefined;
    const row = hasMeta ? db.get("SELECT value FROM meta WHERE key = 'schema_version'") : undefined;
    return { path, exists: true, version: row ? Number(row.value) : 0, failure: null };
  } catch (error) {
    // Any exception here is the database refusing to be read (not a database, locked, a driver missing): a fact.
    const code = isLampstandError(error) ? error.code : "E_STATE_DB";
    return { path, exists: true, version: null, failure: { code, message: errorMessage(error) } };
  } finally {
    db?.close();
  }
}

/**
 * Each scheduled job's health. Without a house.db or a job_runs table no job has run, which is STALE. A state
 * directory or database that cannot be read judges nothing here: the state checks report it.
 * @param {StateDbFacts | null} stateDb
 * @param {import("../governance/jobs.js").Job[]} scheduled
 * @param {number} now
 * @returns {JobHealth[]}
 */
function jobsHealth(stateDb, scheduled, now) {
  /** @param {import("../governance/jobs.js").Job} job @returns {JobHealth} */
  const neverRan = (job) => ({ job: job.id, health: "STALE", last_outcome: null, last_run_at: null, last_landed_at: null, stale_hours: job.staleHours, detail: "" });
  if (stateDb === null || stateDb.failure !== null) return [];
  if (!stateDb.exists) return scheduled.map(neverRan);
  const db = new Database(stateDb.path);
  try {
    if (db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'job_runs'") === undefined) return scheduled.map(neverRan);
    return scheduled.map((job) => jobHealth(db, job, now));
  } finally {
    db.close();
  }
}

/**
 * The house's OS tick entry: whether the OS carries it, which house the seat ledger recorded it for, and the
 * entry's own definition text (the command it runs), read the way its method stores it.
 * @param {SchedulerHost} host
 * @param {string} root
 * @param {string} houseId
 * @returns {TickFacts}
 */
function tickFacts(host, root, houseId) {
  const key = tickKey(root, houseId);
  const result = attempt(() => {
    const entries = recorded(host.env, key);
    const { method, registered } = probe(host, key);
    let definition = null;
    if (registered) {
      if (method === "schtasks") {
        const query = host.run("schtasks", ["/Query", "/TN", key, "/XML"]);
        definition = query.status === 0 ? query.stdout : null;
      } else if (method === "crontab") {
        const listed = host.run("crontab", ["-l"]);
        definition = listed.status === 0 ? listed.stdout.split("\n").filter((line) => line.endsWith(`# ${key}`)).join("\n") : null;
      } else {
        const files = entries.filter((entry) => entry.kind === "file" && isFile(entry.target)).map((entry) => readFileSync(entry.target, "utf8"));
        definition = files.length > 0 ? files.join("\n") : null;
      }
    }
    return { key, method, registered, ledgerHouses: [...new Set(entries.map((entry) => entry.house))], definition };
  });
  return "failure" in result ? { key, failure: result.failure } : result.value;
}
