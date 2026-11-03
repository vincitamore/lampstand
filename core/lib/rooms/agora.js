// @ts-check
// agora as this machine has it: the CLI's version, and how OMP loads agora's room extension. Rooms come from agora,
// a separate package lampstand neither bundles nor installs, so every answer here is read from what is installed.
// Host locations follow the environment (HOME, USERPROFILE, PI_CONFIG_DIR, XDG_DATA_HOME), so a test moves them all.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, stripBom } from "../io.js";
import { compareVersions } from "../init/upgrade.js";
import { attempt, expandHome, homeOf, isDirectory, isFile, which, yamlKey } from "../doctor/util.js";

/** @typedef {import("../doctor/util.js").Runner} Runner */
/** @typedef {import("../doctor/util.js").Failure} Failure */
/** @typedef {"AGORA_MISSING" | "AGORA_TOO_OLD" | "AGORA_VERSION_UNKNOWN"} AgoraProblem */
/**
 * @typedef {{ path: string | null, version: string | null, output: string | null, problem: AgoraProblem | null }} Agora
 *   `output` is what `agora schema --json` printed when it gave no version, for the message.
 * @typedef {{ kind: "plugin" | "path", source: string, path: string }} ExtensionLoad
 * @typedef {{ loads: ExtensionLoad[], plugin: boolean, path: boolean, twice: boolean, unreadable: Failure[] }} Extension
 */

/**
 * The first agora release carrying room safety: a room's wakeFrom list is checked before any wake, and a room the
 * public can post in is refused a watch without one. Earlier releases wake a session on anyone's message.
 */
export const AGORA_FLOOR = "0.2.5";

/**
 * agora is published only as a git repository; the bare npm name belongs to an unrelated publisher, so the hint names
 * the git ref every time.
 */
export const AGORA_INSTALL = [
  `Rooms need agora ${AGORA_FLOOR} or later, a separate open-source package. Install it from its git release, where <tag> is a release tag at ${AGORA_FLOOR} or later:`,
  `  npm install -g "github:vincitamore/agora#<tag>"      the agora command`,
  `  omp plugin install "github:vincitamore/agora#<tag>"  its OMP extension, which wakes sessions`,
  "Never install the bare npm name agora: it belongs to an unrelated publisher.",
].join("\n");

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/**
 * Finds agora on PATH and reads its version from `agora schema --json`, the only place agora states it (it has no
 * --version flag).
 * @param {NodeJS.ProcessEnv} env
 * @param {Runner} run
 * @returns {Agora}
 */
export function detectAgora(env, run) {
  const path = which("agora", env);
  if (path === null) return { path, version: null, output: null, problem: "AGORA_MISSING" };
  const result = run(path, ["schema", "--json"]);
  let version = null;
  if (result.status === 0) {
    try {
      const value = JSON.parse(result.stdout)?.version;
      if (typeof value === "string" && SEMVER.test(value)) version = value;
    } catch {
      // Not JSON: an agora too old to have `schema`, or something else named agora. The output says which.
    }
  }
  if (version === null) {
    const output = `${result.stdout}${result.stderr}`.trim().slice(0, 200);
    return { path, version, output, problem: "AGORA_VERSION_UNKNOWN" };
  }
  return { path, version, output: null, problem: belowFloor(version) ? "AGORA_TOO_OLD" : null };
}

/**
 * True when `version` predates the floor. A pre-release of the floor itself precedes it.
 * @param {string} version
 */
export function belowFloor(version) {
  const order = compareVersions(version, AGORA_FLOOR);
  return order < 0 || (order === 0 && /^[^+]*-/.test(version));
}

/** One line naming why agora cannot serve rooms, or null when it can. @param {Agora} agora */
export function agoraProblemText(agora) {
  if (agora.problem === "AGORA_MISSING") return "agora is not on PATH";
  if (agora.problem === "AGORA_TOO_OLD") {
    return `agora ${agora.version} predates ${AGORA_FLOOR}, the release with room safety (wakeFrom checked before every wake)`;
  }
  if (agora.problem === "AGORA_VERSION_UNKNOWN") {
    return `agora schema --json gave no version (${JSON.stringify(agora.output ?? "")}); agora ${AGORA_FLOOR} or later states it there`;
  }
  return null;
}

/**
 * @param {string} path
 * @param {Failure[]} unreadable
 * @returns {unknown}
 */
function readJson(path, unreadable) {
  if (!isFile(path)) return undefined;
  try {
    return JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch (error) {
    unreadable.push({ code: "E_PARSE_JSON", message: `${path}: ${errorMessage(error)}` });
    return undefined;
  }
}

/**
 * The nearest package.json at or above `path`, four levels at most (an entry such as plugins/omp/agora-room/index.mjs
 * sits three below the agora checkout).
 * @param {string} path
 * @returns {{ dir: string, manifest: { name?: unknown, omp?: { extensions?: unknown } } } | null}
 */
function packageAt(path) {
  let dir = isDirectory(path) ? path : dirname(path);
  for (let k = 0; k < 4; k++) {
    const file = join(dir, "package.json");
    if (isFile(file)) {
      try {
        const manifest = JSON.parse(stripBom(readFileSync(file, "utf8")));
        return { dir, manifest: typeof manifest === "object" && manifest !== null ? manifest : {} };
      } catch {
        return { dir, manifest: {} };
      }
    }
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return null;
}

/**
 * The directory OMP would load agora's room extension through when `path` reaches it, or null. Two packages carry it:
 * the agora checkout (named `agora`, its `omp.extensions` naming plugins/omp/agora-room) and that folder alone (named
 * `agora-room`). Matching on the extension entry, not the name alone, keeps the unrelated npm `agora` out.
 * @param {string} path
 */
function agoraKey(path) {
  if (!existsSync(path)) return null;
  const pkg = packageAt(path);
  if (pkg === null) return null;
  const entries = Array.isArray(pkg.manifest.omp?.extensions) ? pkg.manifest.omp.extensions.filter((entry) => typeof entry === "string") : [];
  if (pkg.manifest.name === "agora-room" && entries.length > 0) return pkg.dir;
  if (pkg.manifest.name === "agora" && entries.some((entry) => /(?:^|[\\/])plugins[\\/]omp[\\/]agora-room(?:[\\/]|$)/.test(entry))) return pkg.dir;
  return null;
}

/**
 * An `extensions` entry as OMP normalizes it: `file://` URLs and `@/absolute` shorthands unwrapped, `~` expanded, a
 * relative path resolved against the working directory.
 * @param {string} entry
 * @param {string} home
 * @param {string} cwd
 */
function extensionPath(entry, home, cwd) {
  let path = entry.trim();
  if (path.startsWith("file://")) path = fileURLToPath(path);
  else if (/^@[\\/]/.test(path) || /^@[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  return resolve(cwd, expandHome(path, home));
}

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** The nearest `.omp` directory at or above `cwd`: OMP's anchor for project plugins. @param {string} cwd */
function projectOmpDir(cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (isDirectory(join(dir, ".omp"))) return join(dir, ".omp");
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Every distinct place OMP loads agora's room extension from. OMP's layout: the user root is
 * `~/<PI_CONFIG_DIR or .omp>`, the agent directory `PI_CODING_AGENT_DIR` or `<root>/agent`, installed plugins under
 * `<root>/plugins` (or `$XDG_DATA_HOME/omp/plugins` once that directory exists, off Windows) and a project's
 * `.omp/plugins`. Extensions also load from the effective config.yml `extensions` list (a project's list replaces the
 * user's), both settings.json lists, and the `extensions/` folders. OMP de-duplicates by path only, so a plugin install
 * beside an `extensions` entry loads the extension twice and every room message arrives twice.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {Extension}
 */
export function agoraExtension(env, cwd) {
  const home = homeOf(env);
  const root = resolve(home, env.PI_CONFIG_DIR || ".omp");
  const agentDir = env.PI_CODING_AGENT_DIR ? resolve(cwd, expandHome(env.PI_CODING_AGENT_DIR, home)) : join(root, "agent");
  const xdgData = env.XDG_DATA_HOME;
  const pluginsRoot =
    process.platform !== "win32" && xdgData && isAbsolute(xdgData) && isDirectory(join(xdgData, "omp")) ? join(xdgData, "omp", "plugins") : join(root, "plugins");
  const project = projectOmpDir(cwd);

  /** @type {Failure[]} */
  const unreadable = [];
  /** @type {ExtensionLoad[]} */
  const loads = [];
  /** @param {ExtensionLoad["kind"]} kind @param {string} source @param {string} path */
  const add = (kind, source, path) => {
    const key = agoraKey(path);
    if (key !== null && !loads.some((load) => load.path === key)) loads.push({ kind, source, path: key });
  };

  // `omp plugin install` names the checkout `agora`; `omp plugin link` of the extension folder names it `agora-room`.
  for (const plugins of new Set([pluginsRoot, ...(project === null ? [] : [join(project, "plugins")])])) {
    for (const name of ["agora", "agora-room"]) {
      const pkg = join(plugins, "node_modules", name);
      if (agoraKey(pkg) === null) continue;
      const lock = /** @type {{ plugins?: Record<string, { enabled?: unknown }> } | undefined} */ (readJson(join(plugins, "omp-plugins.lock.json"), unreadable));
      if (lock?.plugins?.[name]?.enabled === false) continue;
      add("plugin", `installed plugin in ${plugins}`, pkg);
    }
  }

  const userConfig = isFile(join(agentDir, "config.yml")) ? join(agentDir, "config.yml") : join(agentDir, "config.yaml");
  const projectConfig = join(cwd, ".omp", "config.yml");
  const projectList = yamlKey(projectConfig, "extensions", unreadable);
  const [configFile, configured] = projectList !== undefined ? [projectConfig, projectList] : [userConfig, yamlKey(userConfig, "extensions", unreadable)];
  for (const entry of strings(configured)) add("path", `extensions: in ${configFile}`, extensionPath(entry, home, cwd));
  for (const settings of [join(agentDir, "settings.json"), join(cwd, ".omp", "settings.json")]) {
    const data = /** @type {{ extensions?: unknown } | undefined} */ (readJson(settings, unreadable));
    for (const entry of strings(data?.extensions)) add("path", `extensions in ${settings}`, extensionPath(entry, home, cwd));
  }
  for (const folder of [join(agentDir, "extensions"), join(cwd, ".omp", "extensions")]) {
    if (!isDirectory(folder)) continue;
    for (const name of readdirSync(folder).sort()) add("path", `extension folder ${folder}`, join(folder, name));
  }

  return {
    loads,
    plugin: loads.some((load) => load.kind === "plugin"),
    path: loads.some((load) => load.kind === "path"),
    twice: loads.length > 1,
    unreadable,
  };
}
