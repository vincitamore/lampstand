// @ts-check
// Host facts for doctor: where OMP and Hermes keep their configuration, what in it loads lampstand, which Slack
// channels Hermes and agora are attached to, and the versions the host binaries report. Every location follows the
// host's own resolution rules (named beside each reader) and the environment, so a test moves them all by pointing
// HOME, USERPROFILE, LOCALAPPDATA and HERMES_HOME at a temp directory.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, normalizeLf, stripBom } from "../io.js";
import { chars } from "../constitution/budgets.js";
import { PACKAGE_ROOT } from "../init/plant.js";
import { REGION_BEGIN, REGION_END } from "../init/region.js";
import { projectionMarker } from "../constitution/compile.js";
import { detectAgora } from "../rooms/agora.js";
import { attempt, expandHome, homeOf, isDirectory, isFile, which, yamlKey } from "./util.js";

/** @typedef {import("./util.js").Failure} Failure */
/** @typedef {import("./util.js").Runner} Runner */
/** @typedef {import("./facts.js").HouseFacts} HouseFacts */
/**
 * @typedef {{
 *   root: string,
 *   agentDir: string,
 *   executable: string | null,
 *   loads: { source: string, path: string }[],
 *   unreadable: Failure[],
 *   version: string | null,
 *   versionOutput: string | null,
 *   floor: string | null,
 *   shadows: string[],
 * }} OmpFacts
 *   `loads` is every distinct lampstand package OMP imports as an extension; `version` is null when `omp --version`
 *   was not run (lampstand does not load) or printed no version.
 * @typedef {{ kind: string | null, files: string[], regionLoads: boolean | null }} HermesContext
 * @typedef {{
 *   home: string,
 *   plugin: string | null,
 *   enabled: boolean | null,
 *   configFailure: Failure | null,
 *   node: string | null,
 *   context: HermesContext | null,
 *   kernelLog: string | null,
 * }} HermesFacts
 *   `enabled` is null when config.yaml's plugins block is outside lampstand's YAML subset; `kernelLog` is the last
 *   line of agent.log naming the kernel section.
 * @typedef {{
 *   agora: string | null,
 *   version: string | null,
 *   versionOutput: string | null,
 *   rooms: { alias: string, channel: string }[],
 *   hermesChannels: { channel: string, source: string }[],
 *   unreadable: Failure[],
 * }} RoomsFacts
 * @typedef {{ omp: OmpFacts | null, hermes: HermesFacts | null, rooms: RoomsFacts | null }} HostFacts
 */

/** The prompt section id the Hermes adapter registers its kernel under (hosts/hermes/plugin.py SECTION_ID). */
export const HERMES_KERNEL_SECTION = "lampstand-kernel";

/** Hermes's floor for one context file before it keeps only a head and a tail, and that split (hosts/hermes/context.py). */
const CONTEXT_FILE_MAX_CHARS = 20_000;
const TRUNCATE_HEAD_RATIO = 0.7;
const TRUNCATE_TAIL_RATIO = 0.2;

/** How much of the end of agent.log is read: the newest session's lines, without loading a rotated-size file. */
const LOG_TAIL_BYTES = 256 * 1024;

/** The Hermes Slack settings that name channels the gateway answers in, in config.yaml and as variables. */
const SLACK_CHANNEL_KEYS = Object.freeze(["allowed_channels", "free_response_channels", "require_mention_channels", "home_channel"]);
const SLACK_CHANNEL_VARIABLES = Object.freeze(["SLACK_ALLOWED_CHANNELS", "SLACK_FREE_RESPONSE_CHANNELS", "SLACK_REQUIRE_MENTION_CHANNELS", "SLACK_HOME_CHANNEL"]);

/**
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, house: HouseFacts | null, run: Runner }} options
 * @returns {HostFacts}
 */
export function gatherHosts({ env, cwd, house, run }) {
  const hermes = hermesFacts(env, cwd, house?.root ?? null);
  const roomsOn = house !== null && house.config.ok && house.config.modules.rooms;
  return {
    omp: ompFacts(env, cwd, run),
    hermes,
    rooms: roomsOn ? roomsFacts(env, cwd, run) : null,
  };
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
 * The nearest package.json at or above `path` (four levels at most: an entry such as hosts/omp/index.ts sits two
 * below its package), as its directory and name.
 * @param {string} path
 * @returns {{ dir: string, name: unknown } | null}
 */
function packageAt(path) {
  let dir = isDirectory(path) ? path : dirname(path);
  for (let k = 0; k < 4; k++) {
    const file = join(dir, "package.json");
    if (isFile(file)) {
      try {
        return { dir, name: JSON.parse(readFileSync(file, "utf8"))?.name };
      } catch {
        return { dir, name: undefined };
      }
    }
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return null;
}

/**
 * The path OMP would import lampstand through when `path` reaches a lampstand package, or null. OMP de-duplicates
 * extension entries by absolute path without resolving links, so the key is the package directory as reached, and
 * a link to lampstand counts under the link's own path.
 * @param {string} path
 */
function lampstandKey(path) {
  if (!existsSync(path)) return null;
  const reached = packageAt(path);
  if (reached?.name === "lampstand") return reached.dir;
  let real;
  try {
    real = realpathSync.native(path);
  } catch {
    return null;
  }
  return real !== path && packageAt(real)?.name === "lampstand" ? path : null;
}

/**
 * An `extensions:` entry as OMP normalizes it: `file://` URLs and `@/absolute` shorthands unwrapped, `~` expanded,
 * a relative path resolved against the working directory.
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

/**
 * The nearest `.omp` directory at or above `cwd`: OMP's anchor for project plugins and project settings. Like OMP's
 * project discovery (discovery/helpers.ts, getProjectDiscoveryCeilings), the walk never examines the home directory,
 * the temp directory or anything above them, and the user's own config root is never a project's.
 * @param {string} cwd
 * @param {string} home
 * @param {string} userRoot  `~/.omp`, the user's config root
 */
function projectOmpDir(cwd, home, userRoot) {
  /** @param {string} path */
  const same = (path) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  const ceilings = new Set([home, tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/var/tmp"])].map(same));
  for (let dir = resolve(cwd); !ceilings.has(same(dir)); dir = dirname(dir)) {
    const candidate = join(dir, ".omp");
    if (same(candidate) !== same(userRoot) && isDirectory(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
  return null;
}

/** The OMP_FLOOR constant of the shipped OMP adapter, its single source. */
function ompFloor() {
  try {
    const text = readFileSync(join(PACKAGE_ROOT, "hosts", "omp", "index.ts"), "utf8");
    return /export const OMP_FLOOR = "([^"]+)"/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * OMP's layout (omp docs: config-usage, extension-loading, plugin-manager-installer-plumbing): the user root is
 * `~/<PI_CONFIG_DIR or .omp>`, the agent directory `PI_CODING_AGENT_DIR` or `<root>/agent`, installed plugins under
 * `<root>/plugins` (or `$XDG_DATA_HOME/omp/plugins` once that directory exists, off Windows). Extensions load from
 * enabled plugins, from the `extensions` list of the effective config.yml (a project's list replaces the user's),
 * from both settings.json lists, and from the `extensions/` folders of the agent directory and the project.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {Runner} run
 * @returns {OmpFacts | null}
 */
function ompFacts(env, cwd, run) {
  const home = homeOf(env);
  const root = resolve(home, env.PI_CONFIG_DIR || ".omp");
  const agentDir = env.PI_CODING_AGENT_DIR ? resolve(cwd, expandHome(env.PI_CODING_AGENT_DIR, home)) : join(root, "agent");
  const executable = which("omp", env);
  if (executable === null && !isDirectory(root)) return null;

  const xdgData = env.XDG_DATA_HOME;
  const pluginsRoot =
    process.platform !== "win32" && xdgData && isAbsolute(xdgData) && isDirectory(join(xdgData, "omp")) ? join(xdgData, "omp", "plugins") : join(root, "plugins");
  const project = projectOmpDir(cwd, home, root);

  /** @type {Failure[]} */
  const unreadable = [];
  /** @type {OmpFacts["loads"]} */
  const loads = [];
  /** @param {string} source @param {string} path */
  const add = (source, path) => {
    const key = lampstandKey(path);
    if (key !== null && !loads.some((load) => load.path === key)) loads.push({ source, path: key });
  };

  const pluginRoots = [pluginsRoot, ...(project === null ? [] : [join(project, "plugins")])];
  for (const plugins of [...new Set(pluginRoots)]) {
    const pkg = join(plugins, "node_modules", "lampstand");
    if (lampstandKey(pkg) === null) continue;
    const lock = /** @type {{ plugins?: Record<string, { enabled?: unknown }> } | undefined} */ (readJson(join(plugins, "omp-plugins.lock.json"), unreadable));
    if (lock?.plugins?.lampstand?.enabled === false) continue;
    add(`installed plugin in ${plugins}`, pkg);
  }

  const userConfig = isFile(join(agentDir, "config.yml")) ? join(agentDir, "config.yml") : join(agentDir, "config.yaml");
  const projectConfig = join(cwd, ".omp", "config.yml");
  const projectList = yamlKey(projectConfig, "extensions", unreadable);
  const [configFile, configured] = projectList !== undefined ? [projectConfig, projectList] : [userConfig, yamlKey(userConfig, "extensions", unreadable)];
  for (const entry of strings(configured)) add(`extensions: in ${configFile}`, extensionPath(entry, home, cwd));
  for (const settings of [join(agentDir, "settings.json"), join(cwd, ".omp", "settings.json")]) {
    const data = /** @type {{ extensions?: unknown } | undefined} */ (readJson(settings, unreadable));
    for (const entry of strings(data?.extensions)) add(`extensions in ${settings}`, extensionPath(entry, home, cwd));
  }
  for (const folder of [join(agentDir, "extensions"), join(cwd, ".omp", "extensions")]) {
    if (!isDirectory(folder)) continue;
    for (const name of readdirSync(folder).sort()) add(`extension folder ${folder}`, join(folder, name));
  }

  let version = null;
  let versionOutput = null;
  if (loads.length > 0 && executable !== null) {
    const result = run(executable, ["--version"]);
    versionOutput = `${result.stdout}${result.stderr}`.trim();
    version = result.status === 0 ? (/(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null) : null;
  }

  return {
    root,
    agentDir,
    executable,
    loads,
    unreadable,
    version,
    versionOutput,
    floor: ompFloor(),
    shadows: loads.length > 0 ? ompShadows([agentDir, join(cwd, ".omp")]) : [],
  };
}

/**
 * Files in the user's own OMP folders named like the plugin's agents, rules or skills: the user's copy wins.
 * @param {string[]} folders  OMP folders holding agents/, rules/ and skills/
 */
function ompShadows(folders) {
  /** @param {string} dir @param {(name: string) => boolean} keep */
  const names = (dir, keep) => (isDirectory(dir) ? readdirSync(dir).filter(keep).sort() : []);
  const markdown = (/** @type {string} */ name) => name.endsWith(".md");
  const shipped = {
    agents: names(join(PACKAGE_ROOT, "agents"), markdown),
    rules: names(join(PACKAGE_ROOT, "rules"), markdown),
    skills: names(join(PACKAGE_ROOT, "skills"), (name) => isFile(join(PACKAGE_ROOT, "skills", name, "SKILL.md"))),
  };
  /** @type {string[]} */
  const out = [];
  for (const folder of [...new Set(folders)]) {
    for (const [kind, list] of Object.entries(shipped)) {
      for (const name of list) {
        const path = join(folder, kind, name);
        if (existsSync(path)) out.push(path);
      }
    }
  }
  return out;
}

/**
 * Hermes's home: HERMES_HOME, else %LOCALAPPDATA%\hermes on Windows and ~/.hermes elsewhere, each with
 * HERMES_DATA_DIR_SUFFIX (hermes_constants.get_hermes_home).
 * @param {NodeJS.ProcessEnv} env
 */
export function hermesHome(env) {
  const home = homeOf(env);
  const named = (env.HERMES_HOME ?? "").trim();
  if (named !== "") return resolve(expandHome(named, home));
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? "";
  if (process.platform === "win32") {
    const local = (env.LOCALAPPDATA ?? "").trim();
    return join(local !== "" ? local : join(home, "AppData", "Local"), `hermes${suffix}`);
  }
  return join(home, `.hermes${suffix}`);
}

/**
 * The installed Hermes plugin whose manifest names it lampstand, as its directory.
 * @param {string} home
 */
function hermesPlugin(home) {
  const plugins = join(home, "plugins");
  if (!isDirectory(plugins)) return null;
  for (const name of readdirSync(plugins).sort()) {
    const manifest = join(plugins, name, "plugin.yaml");
    if (!isFile(manifest)) continue;
    const named = /^name:[ \t]*["']?([^"'\s#]+)/m.exec(normalizeLf(readFileSync(manifest, "utf8")))?.[1];
    if (named === "lampstand") return join(plugins, name);
  }
  return null;
}

/**
 * Node as the Hermes adapter finds it (hosts/hermes/node.py find_node): PATH, then $HERMES_HOME/node or
 * $HERMES_HOME/node/bin.
 * @param {NodeJS.ProcessEnv} env
 */
function hermesNode(env) {
  const onPath = which("node", env);
  if (onPath !== null) return onPath;
  const home = env.HERMES_HOME;
  if (!home) return null;
  const executable = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of [join(home, "node"), join(home, "node", "bin")]) {
    if (isFile(join(dir, executable))) return join(dir, executable);
  }
  return null;
}

/**
 * The last `length` bytes of a file as text, or null when it cannot be read.
 * @param {string} path
 * @param {number} length
 */
function tail(path, length) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {string | null} houseRoot
 * @returns {HermesFacts | null}
 */
function hermesFacts(env, cwd, houseRoot) {
  const home = hermesHome(env);
  if (!isDirectory(home)) return null;
  const plugin = hermesPlugin(home);
  if (plugin === null) return { home, plugin, enabled: null, configFailure: null, node: null, context: null, kernelLog: null };

  /** @type {Failure[]} */
  const unreadable = [];
  const config = join(home, "config.yaml");
  const plugins = /** @type {Record<string, unknown> | undefined} */ (yamlKey(config, "plugins", unreadable));
  const enabled = unreadable.length > 0 ? null : strings(plugins?.enabled).includes("lampstand") && !strings(plugins?.disabled).includes("lampstand");

  const log = tail(join(home, "logs", "agent.log"), LOG_TAIL_BYTES);
  const kernelLog = log === null ? null : (normalizeLf(log).split("\n").filter((line) => line.includes(HERMES_KERNEL_SECTION)).at(-1) ?? null);

  return {
    home,
    plugin,
    enabled,
    configFailure: unreadable[0] ?? null,
    node: hermesNode(env),
    context: hermesContext(cwd, houseRoot),
    kernelLog,
  };
}

// Python's str.strip() whitespace, which Hermes applies to a context file; JavaScript's trim() also strips U+FEFF.
const PY_SPACE = "[ \\t\\n\\r\\x0b\\x0c\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "g");

/** The file's text as Hermes reads it, stripped; "" when missing or unreadable. @param {string} path */
function readStripped(path) {
  try {
    return readFileSync(path, "utf8").replace(PY_STRIP, "");
  } catch {
    return "";
  }
}

/** The nearest of `start` and its ancestors holding a `.git` entry. @param {string} start */
function gitRoot(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** @param {string} cwd @param {string | null} git */
function agentsChain(cwd, git) {
  const rel = git === null ? "" : relative(git, cwd);
  if (git === null || rel === "" || rel.startsWith("..") || isAbsolute(rel)) return [cwd];
  const parts = rel.split(/[\\/]/);
  return [git, ...parts.map((_, k) => join(git, ...parts.slice(0, k + 1)))];
}

/**
 * Offsets (code points) of the region in `text`, from its begin marker line to the end of its end marker line, when
 * each marker is present once as a whole line, begin before end, with the kernel marker between them.
 * @param {string} text
 * @returns {[number, number] | null}
 */
function regionSpan(text) {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const begin = lines.flatMap((line, k) => (line === REGION_BEGIN ? [k] : []));
  const end = lines.flatMap((line, k) => (line === REGION_END ? [k] : []));
  if (begin.length !== 1 || end.length !== 1 || end[0] <= begin[0]) return null;
  if (!lines.slice(begin[0] + 1, end[0]).includes(projectionMarker("kernel"))) return null;
  const raw = text.split("\n");
  const upTo = (/** @type {number} */ n) => raw.slice(0, n).reduce((sum, line) => sum + chars(line) + 1, 0);
  return [upTo(begin[0]), upTo(end[0]) + chars(raw[end[0]])];
}

/**
 * Which project context file Hermes loads in `workingDir`, and whether the house's AGENTS.md region reaches the
 * prompt. Mirrors hosts/hermes/context.py, which mirrors Hermes's prompt builder: one kind loads, the first found of
 * .hermes.md/HERMES.md (walking up to the git root), the AGENTS.md chain (git root down to cwd; per directory the
 * first non-empty of AGENTS.override.md, AGENTS.md, agents.md), CLAUDE.md (cwd), .cursorrules (cwd).
 * @param {string} workingDir
 * @param {string | null} houseRoot
 * @returns {HermesContext}
 */
export function hermesContext(workingDir, houseRoot) {
  // Hermes resolves the working directory through links before comparing it with the house's real path.
  const cwd = attempt(() => realpathSync.native(workingDir));
  return contextAt("value" in cwd ? cwd.value : workingDir, houseRoot);
}

/**
 * @param {string} cwd
 * @param {string | null} houseRoot
 * @returns {HermesContext}
 */
function contextAt(cwd, houseRoot) {
  const git = gitRoot(cwd);
  const nonEmpty = (/** @type {string[]} */ paths) => paths.filter((path) => isFile(path) && readStripped(path) !== "");

  for (const dir of git === null ? [cwd] : ancestors(cwd)) {
    const found = [".hermes.md", "HERMES.md"].map((name) => join(dir, name)).find(isFile);
    if (found !== undefined || dir === git) {
      if (found !== undefined && readStripped(found) !== "") return { kind: ".hermes.md", files: [found], regionLoads: houseRoot === null ? null : false };
      break;
    }
  }

  const chain = agentsChain(cwd, git);
  const agents = chain.flatMap((dir) => nonEmpty(["AGENTS.override.md", "AGENTS.md", "agents.md"].map((name) => join(dir, name))).slice(0, 1));
  if (agents.length > 0) return { kind: "AGENTS.md", files: agents, regionLoads: houseRoot === null ? null : houseRegionLoads(houseRoot, cwd, chain) };

  const claude = nonEmpty(["CLAUDE.md", "claude.md"].map((name) => join(cwd, name))).slice(0, 1);
  if (claude.length > 0) return { kind: "CLAUDE.md", files: claude, regionLoads: houseRoot === null ? null : false };

  const rules = isDirectory(join(cwd, ".cursor", "rules"))
    ? readdirSync(join(cwd, ".cursor", "rules")).filter((name) => name.endsWith(".mdc")).sort().map((name) => join(cwd, ".cursor", "rules", name))
    : [];
  const cursor = nonEmpty([join(cwd, ".cursorrules"), ...rules]);
  if (cursor.length > 0) return { kind: ".cursorrules", files: cursor, regionLoads: houseRoot === null ? null : false };
  return { kind: null, files: [], regionLoads: houseRoot === null ? null : false };
}

/** `dir` and each of its ancestors. @param {string} dir */
function ancestors(dir) {
  const out = [dir];
  while (dirname(out[out.length - 1]) !== out[out.length - 1]) out.push(dirname(out[out.length - 1]));
  return out;
}

/**
 * @param {string} root
 * @param {string} cwd
 * @param {string[]} chain
 */
function houseRegionLoads(root, cwd, chain) {
  if (!chain.includes(root)) return false;
  for (const name of ["AGENTS.override.md", "AGENTS.md", "agents.md"]) {
    const candidate = join(root, name);
    if (!existsSync(candidate)) continue;
    let content = readStripped(candidate);
    if (content.startsWith("\ufeff")) content = content.slice(1);
    if (content === "") continue;
    const span = regionSpan(content);
    if (span === null) return false;
    const label = root === cwd ? name : relative(cwd, candidate);
    const prefix = chars(`## ${label}\n\n`);
    const total = prefix + chars(content);
    if (total <= CONTEXT_FILE_MAX_CHARS) return true;
    const head = Math.floor(CONTEXT_FILE_MAX_CHARS * TRUNCATE_HEAD_RATIO);
    const kept = Math.floor(CONTEXT_FILE_MAX_CHARS * TRUNCATE_TAIL_RATIO);
    return span[1] + prefix <= head || span[0] + prefix >= total - kept;
  }
  return false;
}

/**
 * A channel list as Hermes accepts it: a YAML list or a comma-separated string.
 * @param {unknown} value
 */
function channelList(value) {
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  return strings(value).map((item) => item.trim()).filter((item) => item !== "");
}

/**
 * The Slack channels a Hermes settings mapping names: the channel lists, the home channel, and the channels that
 * carry a prompt or a skill binding.
 * @param {unknown} block
 * @param {string} where
 * @returns {{ channel: string, source: string }[]}
 */
function slackChannels(block, where) {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return [];
  const map = /** @type {Record<string, unknown>} */ (block);
  /** @type {{ channel: string, source: string }[]} */
  const out = [];
  for (const key of SLACK_CHANNEL_KEYS) for (const channel of channelList(map[key])) out.push({ channel, source: `${where}.${key}` });
  const prompts = map.channel_prompts;
  if (typeof prompts === "object" && prompts !== null && !Array.isArray(prompts)) {
    for (const channel of Object.keys(prompts)) out.push({ channel, source: `${where}.channel_prompts` });
  }
  if (Array.isArray(map.channel_skill_bindings)) {
    for (const binding of map.channel_skill_bindings) {
      const id = typeof binding === "object" && binding !== null ? /** @type {Record<string, unknown>} */ (binding).id : undefined;
      if (typeof id === "string") out.push({ channel: id, source: `${where}.channel_skill_bindings` });
    }
  }
  return out;
}

/**
 * KEY=VALUE lines of a dotenv file, quotes removed; `export ` prefixes allowed.
 * @param {string} path
 */
function dotenv(path) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!isFile(path)) return out;
  for (const line of normalizeLf(readFileSync(path, "utf8")).split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2];
    out[match[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return out;
}

/**
 * Rooms facts: agora's version and the Slack channels attached to agora rooms and to the Hermes gateway. agora's
 * config is AGORA_CONFIG, else ./agora.json, else ~/.agora/config.json (agora src/core.mjs configPath).
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {Runner} run
 * @returns {RoomsFacts}
 */
function roomsFacts(env, cwd, run) {
  const home = homeOf(env);
  /** @type {Failure[]} */
  const unreadable = [];
  // One reading of agora for doctor and the rooms verbs: its schema carries the version (it has no --version flag).
  const { path: agora, version, output: versionOutput } = detectAgora(env, run);

  const configPath = env.AGORA_CONFIG
    ? resolve(cwd, expandHome(env.AGORA_CONFIG, home))
    : isFile(join(cwd, "agora.json"))
      ? join(cwd, "agora.json")
      : join(home, ".agora", "config.json");
  const config = /** @type {{ rooms?: Record<string, { transport?: unknown, channel?: unknown }> } | undefined} */ (readJson(configPath, unreadable));
  /** @type {RoomsFacts["rooms"]} */
  const rooms = [];
  for (const [alias, row] of Object.entries(config?.rooms ?? {})) {
    if (row?.transport === "slack" && typeof row.channel === "string") rooms.push({ alias, channel: row.channel });
  }

  /** @type {RoomsFacts["hermesChannels"]} */
  const hermesChannels = [];
  const hermes = hermesHome(env);
  if (isDirectory(hermes)) {
    const yaml = join(hermes, "config.yaml");
    hermesChannels.push(...slackChannels(yamlKey(yaml, "slack", unreadable), `${yaml}: slack`));
    const platforms = /** @type {Record<string, any> | undefined} */ (yamlKey(yaml, "platforms", unreadable));
    hermesChannels.push(...slackChannels(platforms?.slack?.extra, `${yaml}: platforms.slack.extra`));
    const fileEnv = dotenv(join(hermes, ".env"));
    for (const name of SLACK_CHANNEL_VARIABLES) {
      for (const [where, value] of [[join(hermes, ".env"), fileEnv[name]], ["the environment", env[name]]]) {
        for (const channel of channelList(value)) hermesChannels.push({ channel, source: `${name} in ${where}` });
      }
    }
  }
  return { agora, version, versionOutput, rooms, hermesChannels, unreadable };
}
