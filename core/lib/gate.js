// @ts-check
// The end-of-session maintenance gate. Host adapters call checkGate with the paths the session changed; the gate
// says what the session still owes the house (schema/maintenance.json), as a reminder in `remind` mode or as a reason
// to refuse ending the session in `block` mode, per house.toml [gate] mode. Whether something is owed is decided on
// paths alone, so the answer is the same on every host and never depends on reading what was meant.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gateModeOf, readHouseToml } from "./org/schema.js";

/** git's empty tree, the base for a session that started before the house's first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The house-relative paths a session changed, read from git rather than from the host's tool events, so work recorded
 * through lampstand verbs, the shell or a subagent counts too. Everything committed since the session began counts.
 * A change still in the working tree, tracked or not, counts when its file was modified after the session began, so
 * work an earlier session left uncommitted is not charged to this one. A deleted file has no time to read and counts
 * whenever it is uncommitted. Never reads `git status`. Returns null when git cannot answer, and the caller falls back
 * to the paths it observed itself.
 * @param {string} root
 * @param {{ since: string, sinceMs: number }} session  the commit at session start ("" before the first commit) and
 *   the session's start time in epoch milliseconds
 * @returns {string[] | null}
 */
export function sessionChanges(root, session) {
  /** @param {string[]} args */
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
  /** @param {import("node:child_process").SpawnSyncReturns<string>} result */
  const names = (result) => result.stdout.split("\0").filter(Boolean);
  const base = session.since === "" ? EMPTY_TREE : session.since;
  const head = git("rev-parse", "--verify", "--quiet", "HEAD");
  const now = head.status === 0 ? head.stdout.trim() : "";
  const committed = now === "" || now === session.since ? null : git("diff", "--name-only", "--relative", "-z", base, now, "--");
  const uncommitted = git("diff", "--name-only", "--relative", "-z", now === "" ? EMPTY_TREE : now, "--");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
  const failed = [committed, uncommitted, untracked].some((result) => result !== null && (result.error || result.status !== 0));
  if (head.error || failed) return null;
  /** @param {string} rel @param {boolean} deletedCounts */
  const touched = (rel, deletedCounts) => {
    try {
      return statSync(join(root, rel)).mtimeMs >= session.sinceMs;
    } catch {
      return deletedCounts;
    }
  };
  return [
    ...new Set([
      ...(committed === null ? [] : names(committed)),
      ...names(uncommitted).filter((rel) => touched(rel, true)),
      ...names(untracked).filter((rel) => touched(rel, false)),
    ]),
  ];
}

/** @typedef {"off" | "remind" | "block"} GateMode */
/** @typedef {{ id: string, owed: string, folder: string, triggers: string[] }} Obligation */
/** @typedef {{ version: number, record_folders: string[], obligations: Obligation[] }} Maintenance */
/** @typedef {{ id: string, owed: string, folder: string, because: string[] }} Owed */
/** @typedef {{ mode: GateMode, owed: Owed[], block: string | null }} GateResult */

export const MAINTENANCE = /** @type {Maintenance} */ (
  JSON.parse(readFileSync(new URL("../../schema/maintenance.json", import.meta.url), "utf8"))
);

/** Trigger matching any changed path outside the record folders and the other triggers, in or out of the house. */
const WORK = "work";

/**
 * A changed path as the gate sees it: house-relative with `/`, or null for a path outside the house. Relative input
 * paths are taken as house-relative.
 * @param {string} root
 * @param {string} path
 */
function houseRelative(root, path) {
  const rel = isAbsolute(path) ? relative(root, resolve(path)) : path;
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (clean === "" || clean === ".." || clean.startsWith("../") || isAbsolute(clean)) return null;
  return clean;
}

/** @param {string} rel @param {string} pattern */
function matches(rel, pattern) {
  return pattern.endsWith("/") ? rel.startsWith(pattern) : rel === pattern;
}

/**
 * What a session that changed `changed` owes, judged against `maintenance`.
 * @param {string} root
 * @param {string[]} changed  absolute paths, or paths relative to the house
 * @param {GateMode} mode
 * @param {Maintenance} [maintenance]
 * @returns {GateResult}
 */
export function evaluateGate(root, changed, mode, maintenance = MAINTENANCE) {
  if (mode === "off") return { mode, owed: [], block: null };
  const paths = changed.map((path) => ({ path, rel: houseRelative(root, path) }));
  // A path some obligation names in particular (reflexes/, charter/core.md, ...) owes that obligation, not the generic
  // task and state record, so only a path nothing names is work.
  const named = maintenance.obligations.flatMap((obligation) => obligation.triggers.filter((trigger) => trigger !== WORK));
  /** @param {string | null} rel */
  const isWork = (rel) => rel === null || !(maintenance.record_folders.some((folder) => matches(rel, folder)) || named.some((trigger) => matches(rel, trigger)));
  /** @type {Owed[]} */
  const owed = [];
  for (const obligation of maintenance.obligations) {
    const received = paths.some(({ rel }) => rel !== null && matches(rel, obligation.folder));
    if (received) continue;
    const because = paths
      .filter(({ rel }) => obligation.triggers.some((trigger) => (trigger === WORK ? isWork(rel) : rel !== null && matches(rel, trigger))))
      .map(({ rel, path }) => rel ?? path);
    if (because.length > 0) owed.push({ id: obligation.id, owed: obligation.owed, folder: obligation.folder, because });
  }
  const block =
    mode === "block" && owed.length > 0
      ? `the session owes the house before it ends: ${owed.map((item) => `${item.id} (${item.owed})`).join("; ")}`
      : null;
  return { mode, owed, block };
}

/**
 * The gate for the house at `root`, in the mode its house.toml [gate] sets (remind when unset). With `session`, the
 * paths git reports as changed since the session began are added to `changed`.
 * @param {string} root
 * @param {string[]} changed
 * @param {{ since: string, sinceMs: number }} [session]
 * @returns {GateResult & { source: "observed" | "observed+git" }}
 */
export function checkGate(root, changed, session) {
  const fromGit = session ? sessionChanges(root, session) : null;
  const all = fromGit === null ? changed : [...new Set([...changed, ...fromGit])];
  return { ...evaluateGate(root, all, gateModeOf(readHouseToml(root))), source: fromGit === null ? "observed" : "observed+git" };
}
