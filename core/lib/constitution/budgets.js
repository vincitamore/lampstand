// @ts-check
// Budgets are characters, counted as Unicode code points (what Python's len() counts, so both loaders agree).
// Tokens are reported beside them as an estimate and never gate anything. Totals are derived, never declared.
import { spawnSync } from "node:child_process";
import { fail } from "../errors.js";

/** @typedef {"lean" | "standard" | "large"} Profile */
/** @typedef {"kernel" | "principle-detail" | "charter-core" | "reflex-index" | "voice" | "dynamic-orientation" | "worker"} Surface */

/**
 * The default cap of each surface per profile; `[surfaces.<surface>].cap` in house.toml replaces it (capOf). The
 * worker default is the room W has beyond K, the same in every profile.
 */
export const BUDGETS = Object.freeze({
  standard: Object.freeze({
    kernel: 4000, "principle-detail": 12000, "charter-core": 6000, "reflex-index": 8000, voice: 3000, "dynamic-orientation": 2000, worker: 4000,
  }),
  large: Object.freeze({
    kernel: 4000, "principle-detail": 36000, "charter-core": 8000, "reflex-index": 10000, voice: 3000, "dynamic-orientation": 2000, worker: 4000,
  }),
  lean: Object.freeze({
    kernel: 4000, "principle-detail": 4000, "charter-core": 2000, "reflex-index": 2000, voice: 1000, "dynamic-orientation": 1000, worker: 4000,
  }),
});

/** The kernel size each profile aims for; exceeding it is information, never an error. */
export const KERNEL_TARGET = Object.freeze({ standard: 3500, large: 3500, lean: 2000 });

/**
 * Hermes refuses a plugin prompt section longer than 4,000 characters and offers no larger one, and K is the
 * `lampstand-kernel` section (hosts/hermes/plugin.py SECTION_MAX_CHARS); so K, measured with that section's framing,
 * never exceeds it, and no `[surfaces.kernel].cap` may rise above it.
 */
export const KERNEL_HOST_LIMIT = 4000;

/**
 * Hermes's subagent lifecycle refuses a launch whose context is longer than 32,000 characters, and lampstand_delegate
 * (hosts/hermes/plugin.py) puts W there whole, then the role brief, then the caller's own context. W opens with its
 * marker line and K, which together stay under KERNEL_HOST_LIMIT (the marker line is shorter than the section framing
 * K is measured with); DELEGATE_RESERVE is kept for the brief and the caller. What remains is W's room beyond K on
 * Hermes. OMP appends W to a subagent's system prompt, which has no limit of its own, so W on OMP has none.
 */
export const HERMES_DELEGATE_CONTEXT_CHARS = 32_000;
export const DELEGATE_RESERVE = 8_000;

/**
 * Limits a host imposes, by manifest key. A surface over its host limit is refused whatever its previous size (the
 * host would refuse it whole), and no cap reaches past it.
 */
export const HOST_LIMITS = Object.freeze({
  kernel: KERNEL_HOST_LIMIT,
  "worker:hermes": HERMES_DELEGATE_CONTEXT_CHARS - KERNEL_HOST_LIMIT - DELEGATE_RESERVE,
});

/** The host limit on a manifest key, or null when no host imposes one. @param {string} key */
export function hostLimit(key) {
  return Object.hasOwn(HOST_LIMITS, key) ? HOST_LIMITS[/** @type {keyof typeof HOST_LIMITS} */ (key)] : null;
}

/**
 * Hermes renders a plugin prompt section as `## Plugin Context: <id>\n<!-- hermes-plugin-section-chars:NNNN -->\n\n`
 * before its text; the kernel cap is measured after that framing, with the kernel's own section id, so a host's
 * framing cannot push it over.
 */
export const KERNEL_SECTION_ID = "lampstand-kernel";
export const KERNEL_FRAMING_CHARS =
  `## Plugin Context: ${KERNEL_SECTION_ID}\n`.length + "<!-- hermes-plugin-section-chars:0000 -->\n\n".length;

/** @param {string} text */
export function chars(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** A rough token estimate, reported beside sizes and never used as a gate. @param {number} n */
export function tokensEstimate(n) {
  return Math.ceil(n / 4);
}

/**
 * The `[surfaces]` name that caps a manifest key: the key without its host. So `kernel`, `principle-detail`,
 * `charter-core` and `voice` are capped by the entry of the same name, `reflex-index:<host>` by `reflex-index` and
 * `worker:<host>` by `worker`; one entry caps a surface on every host.
 * @param {string} key
 * @returns {Surface}
 */
export function surfaceOf(key) {
  return /** @type {Surface} */ (key.split(":")[0]);
}

/**
 * The cap a manifest key is measured against: `[surfaces.<surface>].cap` when the operator set it, else the profile's
 * default. A host limit on one host's instance of a surface bounds that instance's cap, so raising the worker for OMP
 * leaves W on Hermes at what Hermes can carry. The kernel's cap is returned as set, even above its limit: K is the same
 * on every host, so such a cap can never hold, and the budget rule refuses it by name.
 * @param {string} key
 * @param {Profile} profile
 * @param {Record<string, unknown> | null} surfaces  house.toml's [surfaces] table
 */
export function capOf(key, profile, surfaces) {
  const surface = surfaceOf(key);
  const entry = surfaces?.[surface];
  const set = typeof entry === "object" && entry !== null ? /** @type {{ cap?: unknown }} */ (entry).cap : undefined;
  const cap = typeof set === "number" && Number.isInteger(set) ? set : BUDGETS[profile][surface];
  const limit = hostLimit(key);
  return limit !== null && key !== surface ? Math.min(cap, limit) : cap;
}

export const MANIFEST_PATH = ".house/generated/manifest.json";

/**
 * The manifest at the house's previous commit, read with `git show HEAD:<path>`, or null when the house is not a git
 * repository, has no commit, or the commit holds no manifest: then no surface has a previous size.
 * @param {string} root
 * @returns {import("./compile.js").Manifest | null}
 */
export function previousManifest(root) {
  const shown = spawnSync("git", ["show", `HEAD:./${MANIFEST_PATH}`], { cwd: root, encoding: "utf8", windowsHide: true });
  if (shown.error || shown.status !== 0) return null;
  try {
    return JSON.parse(shown.stdout);
  } catch (cause) {
    throw fail("E_SCHEMA", "the committed manifest is not JSON", { path: `HEAD:${MANIFEST_PATH}`, cause });
  }
}
