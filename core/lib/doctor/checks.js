// @ts-check
// Doctor's checks. Each is a pure function from gathered facts (facts.js, hosts.js) to findings, and every finding
// code carries one exit class (DESIGN §12):
//   0  healthy (information only)
//   1  broken, and a re-run, `lampstand compile`, `lampstand upgrade` or a restart fixes it
//   2  broken, and a person must act (a schema newer than the code, a double load, a missing runtime)
//   3  no house here, or setup unfinished
// A check is objective: it reports a state that is wrong on the evidence of the files, the database, PATH or the
// host's own records, never a judgement about content. `quick` marks the core checks that need no network and no
// host process, the set `doctor --quick` runs.
import { join } from "node:path";
import { HOUSE_SCHEMA_VERSION } from "../config.js";
import { hostLimit, surfaceOf } from "../constitution/budgets.js";
import { GENERATED_DIR } from "../constitution/compile.js";
import { AGENTS_FILE } from "../init/region.js";
import { VERSION } from "../init/plant.js";
import { compareVersions } from "../init/upgrade.js";
import { STATE_SCHEMA_VERSION } from "../state/db.js";
import { AGORA_FLOOR, belowFloor } from "../rooms/agora.js";
import { HERMES_KERNEL_SECTION } from "./hosts.js";
import { isWithin } from "./util.js";

/** @typedef {import("./facts.js").Facts} Facts */
/** @typedef {0 | 1 | 2 | 3} ExitClass */
/** @typedef {"core" | "omp" | "hermes" | "rooms"} Area */
/** @typedef {{ code: string, area: Area, level: "error" | "info", message: string, fix: string }} Finding */
/** @typedef {{ code: string, message: string, fix?: string }} Raw */
/**
 * @typedef {{
 *   id: string,
 *   area: Area,
 *   quick: boolean,
 *   codes: Record<string, ExitClass>,
 *   check: (facts: Facts) => Raw[],
 * }} Check
 */

/** File systems on which SQLite's WAL locking is unreliable: network and user-space remote mounts. */
const NETWORK_FILESYSTEMS = Object.freeze(
  new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "sshfs", "fuse.sshfs", "9p", "afs", "ceph", "glusterfs", "fuse.rclone", "davfs", "fuse.davfs2"]),
);

/** @param {Facts} facts */
const houseOf = (facts) => facts.house;

/** @param {string} text */
function xmlEscaped(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** @type {Check[]} */
export const CHECKS = [
  {
    id: "house-marker",
    area: "core",
    quick: true,
    codes: { NO_HOUSE: 3, HOUSE_UNRESOLVED: 3, SETUP_UNFINISHED: 3, HOUSE_ROOT_ELSEWHERE: 0 },
    check(facts) {
      const found = facts.resolution;
      if (found.root === null) {
        if (found.failure !== null) {
          return [{ code: "HOUSE_UNRESOLVED", message: found.failure.message, fix: "point HOUSE_ROOT at a directory holding house.toml, or unset it" }];
        }
        return [{ code: "NO_HOUSE", message: `no house.toml at or above ${facts.cwd}, and HOUSE_ROOT is not set`, fix: "lampstand init, or run from inside a house" }];
      }
      /** @type {Raw[]} */
      const out = [];
      if (facts.house !== null && !facts.house.planted) {
        out.push({ code: "SETUP_UNFINISHED", message: `${found.root} has house.toml but no .house/planted.json: lampstand init did not finish here`, fix: "lampstand init" });
      }
      if (facts.walkUp !== null && facts.walkUp !== found.root) {
        out.push({ code: "HOUSE_ROOT_ELSEWHERE", message: `HOUSE_ROOT selects ${found.root}; without it, ${facts.cwd} belongs to ${facts.walkUp}` });
      }
      return out;
    },
  },
  {
    id: "house-toml",
    area: "core",
    quick: true,
    codes: { HOUSE_TOML_INVALID: 2, HOUSE_SCHEMA_NEWER: 2, HOUSE_SCHEMA_OLDER: 1, PLUGIN_TOO_OLD: 2 },
    check(facts) {
      const house = houseOf(facts);
      if (house === null) return [];
      const config = house.config;
      if (!config.ok) {
        if (config.failure.code === "E_SCHEMA_NEWER") return [{ code: "HOUSE_SCHEMA_NEWER", message: config.failure.message, fix: "upgrade lampstand through your host's plugin command" }];
        return [{ code: "HOUSE_TOML_INVALID", message: config.failure.message, fix: "edit house.toml so it matches schema/house.schema.json" }];
      }
      /** @type {Raw[]} */
      const out = [];
      if (config.schema < HOUSE_SCHEMA_VERSION) {
        out.push({ code: "HOUSE_SCHEMA_OLDER", message: `house.schema = ${config.schema}; this lampstand migrates houses to ${HOUSE_SCHEMA_VERSION}`, fix: "lampstand upgrade" });
      }
      if (config.pluginMin !== null && compareVersions(config.pluginMin, VERSION) > 0) {
        out.push({ code: "PLUGIN_TOO_OLD", message: `[plugin] min = "${config.pluginMin}" is newer than this lampstand (${VERSION})`, fix: "upgrade lampstand through your host's plugin command" });
      }
      return out;
    },
  },
  {
    id: "projections",
    area: "core",
    quick: true,
    codes: { CONSTITUTION_INVALID: 2, COMPILE_REFUSED: 2, PROJECTION_MISSING: 1, PROJECTION_STALE: 1, REGION_STALE: 1 },
    check(facts) {
      const house = houseOf(facts);
      if (house === null || house.constitution === null || house.generated === null) return [];
      /** @type {Raw[]} */
      const out = [];
      const constitution = house.constitution;
      if (!constitution.ok) {
        out.push({ code: "CONSTITUTION_INVALID", message: constitution.failure.message, fix: "correct the file it names; lampstand compile then rebuilds the projections" });
      }
      // While a curation rule fails, lampstand compile refuses to write: naming it as the fix would send the reader in
      // a circle, so every fix names the files to correct instead.
      const refused = constitution.ok ? constitution.refused ?? [] : [];
      const files = [...new Set(refused.map((finding) => finding.path).filter((path) => path !== null))];
      const compile = refused.length === 0 ? "lampstand compile" : `correct ${files.length > 0 ? files.join(", ") : "the constitution (see COMPILE_REFUSED)"}, then lampstand compile`;
      for (const finding of refused) {
        out.push({ code: "COMPILE_REFUSED", message: `${finding.path ? `${finding.path}: ` : ""}${finding.message}; lampstand compile refuses until it is fixed`, fix: `correct ${finding.path ?? "the file it names"}` });
      }
      const { inputHash, files: generated } = house.generated;
      if ("code" in generated) return [...out, { code: "PROJECTION_STALE", message: generated.message, fix: compile }];
      const onDisk = new Map(generated.map((file) => [file.name, file.inputHash]));
      if (constitution.ok) {
        for (const name of constitution.expected) {
          if (!onDisk.has(name)) out.push({ code: "PROJECTION_MISSING", message: `${GENERATED_DIR}/${name} is missing`, fix: compile });
        }
      }
      if (typeof inputHash === "string") {
        for (const [name, recorded] of onDisk) {
          if (recorded === null) out.push({ code: "PROJECTION_STALE", message: `${GENERATED_DIR}/${name} carries no input hash`, fix: compile });
          else if (recorded !== inputHash) {
            out.push({ code: "PROJECTION_STALE", message: `${GENERATED_DIR}/${name} was compiled from inputs that have since changed (input-hash ${recorded.slice(0, 12)}, now ${inputHash.slice(0, 12)})`, fix: compile });
          }
        }
      }
      if (constitution.ok && constitution.regionStale) {
        out.push({ code: "REGION_STALE", message: `the generated region of ${AGENTS_FILE} differs from a fresh compile`, fix: compile });
      }
      return out;
    },
  },
  {
    id: "budgets",
    area: "core",
    quick: true,
    codes: { BUDGET_OVER_ENVELOPE: 2 },
    check(facts) {
      const constitution = houseOf(facts)?.constitution;
      if (!constitution?.ok) return [];
      // The envelopes are the limits a host imposes and refuses whole beyond: Hermes's kernel prompt section and its
      // subagent context, which carries W. A kernel cap set above its envelope can never hold. Other caps, and an
      // operator's cap below an envelope, are the ratchet's business.
      return Object.entries(constitution.surfaces).flatMap(([key, size]) => {
        const limit = hostLimit(key);
        if (limit === null) return [];
        const out = [];
        if (size.cap > limit) {
          out.push({
            code: "BUDGET_OVER_ENVELOPE",
            message: `${key}: its cap is ${size.cap}; hosts load at most ${limit}`,
            fix: `lower [surfaces.${surfaceOf(key)}].cap in house.toml to ${limit} or less`,
          });
        }
        if (size.chars > limit) {
          out.push({
            code: "BUDGET_OVER_ENVELOPE",
            message: `${key} is ${size.chars} chars; hosts load at most ${limit}`,
            fix: `shorten what ${key} carries until lampstand compile measures it within ${limit}`,
          });
        }
        return out;
      });
    },
  },
  {
    id: "state-db",
    area: "core",
    quick: true,
    codes: { STATE_DB_NEWER: 2, STATE_DB_UNREADABLE: 2 },
    check(facts) {
      const db = houseOf(facts)?.stateDb;
      if (!db?.exists) return [];
      if (db.failure !== null) {
        return [{ code: "STATE_DB_UNREADABLE", message: `${db.path}: ${db.failure.message}`, fix: `move ${db.path} aside; it holds machine state only and is rebuilt on next use` }];
      }
      if (db.version !== null && db.version > STATE_SCHEMA_VERSION) {
        return [{ code: "STATE_DB_NEWER", message: `${db.path} is at schema version ${db.version}; this lampstand knows up to ${STATE_SCHEMA_VERSION}`, fix: "upgrade lampstand through your host's plugin command" }];
      }
      return [];
    },
  },
  {
    id: "state-local",
    area: "core",
    quick: true,
    codes: { STATE_DIR_INVALID: 2, STATE_DIR_NOT_LOCAL: 2 },
    check(facts) {
      const house = houseOf(facts);
      const state = house?.stateDir;
      if (!house || !state) return [];
      if ("failure" in state) return [{ code: "STATE_DIR_INVALID", message: state.failure.message, fix: "correct state_dir in per-user config.toml" }];
      const fix = "set an absolute local path as state_dir for this house in per-user config.toml";
      /** @type {string | null} */
      let why = null;
      if (isWithin(state.dir, house.root)) why = "it lies inside the house, so git would carry machine state";
      else if (facts.platform === "win32" && /^\\\\(?![?.]\\[A-Za-z]:)/.test(state.dir)) why = "it is a network (UNC) path";
      else if (state.mount !== null && NETWORK_FILESYSTEMS.has(state.mount.type)) why = `it is on a ${state.mount.type} mount (${state.mount.point})`;
      else {
        const synced = state.syncRoots.find((root) => isWithin(state.dir, root));
        if (synced !== undefined) why = `it lies inside ${synced}, which a sync client copies while SQLite writes`;
      }
      return why === null ? [] : [{ code: "STATE_DIR_NOT_LOCAL", message: `the state directory ${state.dir} is not local: ${why}`, fix }];
    },
  },
  {
    id: "jobs",
    area: "core",
    quick: true,
    codes: { JOB_STALE: 1, JOB_NOT_LANDED: 1, JOB_REJECTED: 2 },
    check(facts) {
      const house = houseOf(facts);
      const jobs = house?.jobs;
      if (!house || !jobs) return [];
      /** @type {Raw[]} */
      const out = [];
      for (const job of jobs.health) {
        const last = job.last_landed_at === null ? "it has never landed" : `it last landed ${job.last_landed_at}`;
        const detail = job.detail === "" ? "" : `: ${job.detail}`;
        if (job.health === "STALE") out.push({ code: "JOB_STALE", message: `job ${job.job}: ${last}, and it goes stale after ${job.stale_hours}h`, fix: `lampstand run ${job.job}` });
        else if (job.health === "NOT_LANDED") out.push({ code: "JOB_NOT_LANDED", message: `job ${job.job}: its last run's commit did not carry exactly what it landed${detail}`, fix: `lampstand run ${job.job}` });
        else if (job.health === "REJECTED") {
          out.push({ code: "JOB_REJECTED", message: `job ${job.job}: its last run staged a path outside its outputs${detail}`, fix: `make the job write only under [jobs.${job.job}] outputs, or widen them` });
        }
      }
      return out;
    },
  },
  {
    // The OS tick entry is asked of the scheduler (a host process), so it is not a --quick check; a tick that runs
    // doctor --quick is itself launched by that entry.
    id: "tick-entry",
    area: "core",
    quick: false,
    codes: { TICK_ENTRY_MISSING: 1, TICK_ENTRY_ELSEWHERE: 1, SEAT_LEDGER_INVALID: 2 },
    check(facts) {
      const house = houseOf(facts);
      const tick = house?.jobs?.tick;
      if (!house || !tick) return [];
      /** @type {Raw[]} */
      const out = [];
      if ("failure" in tick) {
        out.push({ code: "SEAT_LEDGER_INVALID", message: tick.failure.message, fix: "repair seat.json beside per-user config.toml" });
      } else if (!tick.registered) {
        out.push({ code: "TICK_ENTRY_MISSING", message: `the scheduler module is on, and the OS carries no tick entry ${tick.key} (${tick.method})`, fix: "lampstand scheduler enable" });
      } else {
        const elsewhere = tick.ledgerHouses.filter((recorded) => recorded !== house.root);
        const named = tick.definition === null || tick.definition.includes(house.root) || tick.definition.includes(xmlEscaped(house.root));
        if (elsewhere.length > 0 || !named) {
          const why = elsewhere.length > 0 ? `the seat ledger records it for ${elsewhere.join(", ")}` : "its command does not name this house";
          out.push({ code: "TICK_ENTRY_ELSEWHERE", message: `tick entry ${tick.key}: ${why}`, fix: "lampstand scheduler disable, then lampstand scheduler enable" });
        }
      }
      return out;
    },
  },
  {
    id: "runtimes",
    area: "core",
    quick: true,
    codes: { RUNTIME_MISSING: 2, GIT_MISSING: 2 },
    check(facts) {
      /** @type {Raw[]} */
      const out = [];
      if (facts.path.node === null && facts.path.bun === null) {
        out.push({ code: "RUNTIME_MISSING", message: "neither node nor bun is on PATH", fix: "install Node.js 22.13 or later" });
      }
      if (facts.path.git === null) out.push({ code: "GIT_MISSING", message: "git is not on PATH", fix: "install git" });
      return out;
    },
  },
  {
    id: "proposals",
    area: "core",
    quick: true,
    codes: { PROPOSALS_WAITING: 0 },
    check(facts) {
      const waiting = houseOf(facts)?.proposals ?? [];
      if (waiting.length === 0) return [];
      return [{ code: "PROPOSALS_WAITING", message: `${waiting.length} proposal${waiting.length === 1 ? "" : "s"} waiting: ${waiting.join(", ")}`, fix: "lampstand adopt" }];
    },
  },
  {
    id: "omp-version",
    area: "omp",
    quick: false,
    codes: { OMP_TOO_OLD: 2 },
    check(facts) {
      const omp = facts.hosts?.omp;
      if (!omp || omp.loads.length === 0 || omp.floor === null || omp.executable === null) return [];
      if (omp.version !== null && compareVersions(omp.version, omp.floor) >= 0) return [];
      const seen = omp.version ?? `no version (${JSON.stringify(omp.versionOutput ?? "")})`;
      return [{ code: "OMP_TOO_OLD", message: `OMP reports ${seen}; lampstand needs ${omp.floor} or later and stays off below it`, fix: "upgrade OMP" }];
    },
  },
  {
    id: "omp-double-load",
    area: "omp",
    quick: false,
    codes: { OMP_DOUBLE_LOAD: 2, OMP_CONFIG_UNREADABLE: 0 },
    check(facts) {
      const omp = facts.hosts?.omp;
      if (!omp) return [];
      /** @type {Raw[]} */
      const out = omp.unreadable.map((failure) => ({ code: "OMP_CONFIG_UNREADABLE", message: `not checked for lampstand: ${failure.message}` }));
      if (omp.loads.length > 1) {
        out.push({
          code: "OMP_DOUBLE_LOAD",
          message: `OMP loads lampstand ${omp.loads.length} times: ${omp.loads.map((load) => `${load.path} (${load.source})`).join("; ")}`,
          fix: "keep the installed plugin and remove the other entries",
        });
      }
      return out;
    },
  },
  {
    id: "omp-shadowing",
    area: "omp",
    quick: false,
    codes: { OMP_SHADOWED: 0 },
    check(facts) {
      return (facts.hosts?.omp?.shadows ?? []).map((path) => ({ code: "OMP_SHADOWED", message: `${path} shadows the lampstand file of the same name` }));
    },
  },
  {
    id: "hermes-enabled",
    area: "hermes",
    quick: false,
    codes: { HERMES_PLUGIN_DISABLED: 3, HERMES_CONFIG_UNREADABLE: 0 },
    check(facts) {
      const hermes = facts.hosts?.hermes;
      if (!hermes || hermes.plugin === null) return [];
      if (hermes.enabled === null) {
        return [{ code: "HERMES_CONFIG_UNREADABLE", message: `whether Hermes enables lampstand was not checked: ${hermes.configFailure?.message ?? "config.yaml is unreadable"}` }];
      }
      if (hermes.enabled) return [];
      return [{ code: "HERMES_PLUGIN_DISABLED", message: `lampstand is installed at ${hermes.plugin} but plugins.enabled in ${join(hermes.home, "config.yaml")} does not enable it`, fix: "hermes plugins enable lampstand" }];
    },
  },
  {
    id: "hermes-node",
    area: "hermes",
    quick: false,
    codes: { HERMES_NODE_MISSING: 2 },
    check(facts) {
      const hermes = facts.hosts?.hermes;
      if (!hermes || hermes.plugin === null || hermes.node !== null) return [];
      return [{ code: "HERMES_NODE_MISSING", message: "the Hermes adapter finds no node on PATH or under $HERMES_HOME/node, so orientation and the gate are off", fix: "install Node.js 22.13 or later, then restart Hermes" }];
    },
  },
  {
    id: "hermes-context",
    area: "hermes",
    quick: false,
    codes: { HERMES_CONTEXT: 0 },
    check(facts) {
      const context = facts.hosts?.hermes?.context;
      if (!context) return [];
      const files = context.kind === null ? "no project context file" : `${context.kind}: ${context.files.join(", ")}`;
      const region = context.regionLoads === null ? "" : context.regionLoads ? "; the house's AGENTS.md region loads, so the kernel section is a pointer" : "; the house's AGENTS.md region does not load, so the kernel section carries K";
      return [{ code: "HERMES_CONTEXT", message: `Hermes in ${facts.cwd} loads ${files}${region}` }];
    },
  },
  {
    id: "hermes-kernel-budget",
    area: "hermes",
    quick: false,
    codes: { HERMES_KERNEL_SKIPPED: 2 },
    check(facts) {
      const hermes = facts.hosts?.hermes;
      const line = hermes?.kernelLog;
      if (!hermes || hermes.plugin === null || !line || !/was skipped/.test(line)) return [];
      return [{
        code: "HERMES_KERNEL_SKIPPED",
        message: `Hermes's last session skipped the ${HERMES_KERNEL_SECTION} prompt section: ${line.trim()}`,
        fix: "disable a plugin whose prompt sections fill Hermes's shared budget, then start a new session",
      }];
    },
  },
  {
    id: "agora-version",
    area: "rooms",
    quick: false,
    codes: { AGORA_MISSING: 2, AGORA_TOO_OLD: 2, AGORA_VERSION_UNKNOWN: 2 },
    check(facts) {
      const rooms = facts.hosts?.rooms;
      if (!rooms) return [];
      const fix = `install agora ${AGORA_FLOOR} or later from its git release`;
      if (rooms.agora === null) return [{ code: "AGORA_MISSING", message: "[modules] rooms is on and agora is not on PATH", fix }];
      if (rooms.version === null) {
        return [{ code: "AGORA_VERSION_UNKNOWN", message: `agora schema --json reported no version (${JSON.stringify(rooms.versionOutput ?? "")})`, fix }];
      }
      if (belowFloor(rooms.version)) {
        return [{ code: "AGORA_TOO_OLD", message: `agora ${rooms.version} predates ${AGORA_FLOOR}, the release with the room-safety fixes`, fix }];
      }
      return [];
    },
  },
  {
    id: "rooms-channels",
    area: "rooms",
    quick: false,
    codes: { ROOM_CHANNEL_SHARED: 2, ROOMS_CONFIG_UNREADABLE: 0 },
    check(facts) {
      const rooms = facts.hosts?.rooms;
      if (!rooms) return [];
      /** @type {Raw[]} */
      const out = rooms.unreadable.map((failure) => ({ code: "ROOMS_CONFIG_UNREADABLE", message: `not checked for shared channels: ${failure.message}` }));
      for (const room of rooms.rooms) {
        const hermes = rooms.hermesChannels.filter((entry) => entry.channel === room.channel);
        if (hermes.length === 0) continue;
        out.push({
          code: "ROOM_CHANNEL_SHARED",
          message: `Slack channel ${room.channel} is agora room ${room.alias} and is attached to Hermes (${hermes.map((entry) => entry.source).join("; ")}): one message would reach the agent twice`,
          fix: `detach ${room.channel} from Hermes or from agora`,
        });
      }
      return out;
    },
  },
];

/**
 * @param {Facts} facts
 * @param {{ quick: boolean }} options
 * @returns {{ exit: ExitClass, findings: Finding[], ran: string[] }}
 */
export function runChecks(facts, { quick }) {
  /** @type {(Finding & { exit: ExitClass })[]} */
  const all = [];
  const ran = [];
  for (const check of CHECKS) {
    if (quick && !check.quick) continue;
    ran.push(check.id);
    for (const raw of check.check(facts)) {
      const exit = check.codes[raw.code];
      if (exit === undefined) throw new Error(`check ${check.id} reported ${raw.code}, which it does not declare`);
      all.push({ code: raw.code, area: check.area, level: exit === 0 ? "info" : "error", message: raw.message, fix: raw.fix ?? "", exit });
    }
  }
  // Most severe first, so the first line of the report is the finding that decides the exit.
  const sorted = all.map((finding, k) => ({ finding, k })).sort((a, b) => b.finding.exit - a.finding.exit || a.k - b.k).map(({ finding }) => finding);
  const exit = /** @type {ExitClass} */ (Math.max(0, ...sorted.map((finding) => finding.exit)));
  return { exit, findings: sorted.map(({ exit: _, ...finding }) => finding), ran };
}
