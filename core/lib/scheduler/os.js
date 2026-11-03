// @ts-check
// The one OS scheduler entry per house that runs `lampstand tick --house <root>` every TICK_MINUTES, as the user and
// without administrator rights:
//
//   win32   a per-user Task Scheduler task (schtasks, no /RU, so it runs as the creating user while logged on)
//   linux   a systemd user service and timer under ~/.config/systemd/user; a crontab line when `systemctl --user`
//           does not answer (containers, WSL without systemd, minimal hosts)
//   darwin  a launchd agent in ~/Library/LaunchAgents, bootstrapped into the gui/<uid> domain
//
// Every OS command goes through `host.run`, so tests substitute a recorder and assert the exact commands. Each
// write is recorded in the seat ledger with its before-value, before it is made; `disable` reverses exactly the
// recorded entries, probing first so an entry the user already removed is not an error.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "../errors.js";
import { atomicWrite } from "../io.js";
import { rootHash } from "../state/paths.js";
import { dropSeat, readSeat, recordSeat } from "../seat/ledger.js";
import { TICK_MINUTES } from "./tick.js";

/** @typedef {import("../seat/ledger.js").SeatEntry} SeatEntry */
/** @typedef {{ status: number | null, stdout: string, stderr: string }} CommandResult */
/** @typedef {(command: string, args: string[], options?: { input?: string }) => CommandResult} Runner */
/**
 * @typedef {{
 *   platform: NodeJS.Platform,
 *   run: Runner,
 *   home: string,
 *   uid: number,
 *   env: NodeJS.ProcessEnv,
 *   scratch: string,
 * }} Host
 *   `env` locates the seat ledger and XDG_CONFIG_HOME; `scratch` is a private directory for temporary files.
 */
/** @typedef {"schtasks" | "systemd" | "crontab" | "launchd"} Method */
/**
 * @typedef {{ kind: "file", target: string, content: string }
 *   | { kind: "schtasks", target: string, command: string }
 *   | { kind: "systemd-timer", target: string }
 *   | { kind: "crontab", target: "crontab", line: string }
 *   | { kind: "launchd", target: string, plist: string }} Step
 */
/** @typedef {{ method: Method, key: string, steps: Step[], describe: string[] }} Plan */

const BIN = fileURLToPath(new URL("../../bin/lampstand.js", import.meta.url));

/** schtasks refuses a /TR value longer than this. */
const SCHTASKS_TR_MAX = 261;

/**
 * The real host: OS commands run for real.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} scratch
 * @returns {Host}
 */
export function realHost(env, scratch) {
  return {
    platform: process.platform,
    home: homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    env,
    scratch,
    run(command, args, options = {}) {
      const result = spawnSync(command, args, { encoding: "utf8", input: options.input, windowsHide: true });
      if (result.error) return { status: null, stdout: "", stderr: result.error.message };
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

/**
 * The entry name for a house: unique per house id and checkout, like its state directory.
 * @param {string} root
 * @param {string} houseId
 */
export function tickKey(root, houseId) {
  return `lampstand-tick-${houseId.slice(0, 8)}-${rootHash(root)}`;
}

/** The command the entry runs. @param {string} root */
export function tickArgv(root) {
  return [process.execPath, BIN, "tick", "--house", root];
}

/** @param {Host} host */
function systemdDir(host) {
  const xdg = host.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(host.home, ".config"), "systemd", "user");
}

/** @param {string} key */
const launchdLabel = (key) => `dev.lampstand.${key}`;

/** @param {Host} host @param {string} key */
const launchdTarget = (host, key) => `gui/${host.uid}/${launchdLabel(key)}`;

/** @param {string} text */
function xml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A systemd ExecStart word: C-style quoting, with % and $ doubled so systemd expands nothing. @param {string} text */
function systemdWord(text) {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/** A POSIX shell word for a crontab line; cron turns an unescaped % into a newline. @param {string} text */
function cronWord(text) {
  return `'${text.replace(/'/g, "'\\''").replace(/%/g, "\\%")}'`;
}

/** @param {Host} host */
function systemdAvailable(host) {
  return host.run("systemctl", ["--user", "show-environment"]).status === 0;
}

/**
 * What `enable` will create on this host. On Linux this asks systemd whether a user manager answers.
 * @param {Host} host
 * @param {string} key
 * @param {string[]} argv
 * @returns {Plan}
 */
export function plan(host, key, argv) {
  const every = `every ${TICK_MINUTES} minutes`;
  if (host.platform === "win32") {
    const command = argv.map((word, k) => (k === 2 || k === 3 ? word : `"${word}"`)).join(" ");
    if (command.length > SCHTASKS_TR_MAX) {
      throw fail("E_USAGE", `the tick command is ${command.length} characters, over schtasks' ${SCHTASKS_TR_MAX}: ${command}`);
    }
    return {
      method: "schtasks",
      key,
      steps: [{ kind: "schtasks", target: key, command }],
      describe: [`Task Scheduler task "${key}" for the current user, ${every}, running: ${command}`],
    };
  }
  if (host.platform === "darwin") {
    const label = launchdLabel(key);
    const path = join(host.home, "Library", "LaunchAgents", `${label}.plist`);
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${xml(label)}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...argv.map((word) => `    <string>${xml(word)}</string>`),
      "  </array>",
      `  <key>StartInterval</key><integer>${TICK_MINUTES * 60}</integer>`,
      "  <key>ProcessType</key><string>Background</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    return {
      method: "launchd",
      key,
      steps: [
        { kind: "file", target: path, content },
        { kind: "launchd", target: launchdTarget(host, key), plist: path },
      ],
      describe: [`file ${path}`, `launchd agent ${label} in gui/${host.uid}, ${every}, running: ${argv.join(" ")}`],
    };
  }
  if (systemdAvailable(host)) {
    const dir = systemdDir(host);
    const service = [
      "[Unit]",
      `Description=lampstand tick for ${argv[4]}`,
      "",
      "[Service]",
      "Type=oneshot",
      `ExecStart=${argv.map(systemdWord).join(" ")}`,
      "",
    ].join("\n");
    const timer = [
      "[Unit]",
      `Description=lampstand tick ${every} for ${argv[4]}`,
      "",
      "[Timer]",
      `OnCalendar=*:0/${TICK_MINUTES}`,
      "Persistent=true",
      `Unit=${key}.service`,
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n");
    return {
      method: "systemd",
      key,
      steps: [
        { kind: "file", target: join(dir, `${key}.service`), content: service },
        { kind: "file", target: join(dir, `${key}.timer`), content: timer },
        { kind: "systemd-timer", target: `${key}.timer` },
      ],
      describe: [
        `file ${join(dir, `${key}.service`)}`,
        `file ${join(dir, `${key}.timer`)}`,
        `systemd user timer ${key}.timer, ${every}, running: ${argv.join(" ")}`,
      ],
    };
  }
  const line = `*/${TICK_MINUTES} * * * * ${argv.map(cronWord).join(" ")} # ${key}`;
  return {
    method: "crontab",
    key,
    steps: [{ kind: "crontab", target: "crontab", line }],
    describe: [`crontab line (systemctl --user is unavailable): ${line}`],
  };
}

/**
 * @param {Host} host
 * @param {string} command
 * @param {string[]} args
 * @param {{ input?: string }} [options]
 */
function must(host, command, args, options) {
  const result = host.run(command, args, options);
  if (result.status !== 0) {
    const why = (result.stderr || result.stdout || "no output").trim();
    throw fail("E_IO", `${command} ${args.join(" ")} failed (exit ${result.status ?? "none"}): ${why}`);
  }
  return result;
}

/** @param {string} path */
function readOrNull(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The current crontab, or null when the user has none. @param {Host} host */
function readCrontab(host) {
  const result = host.run("crontab", ["-l"]);
  if (result.status === 0) return result.stdout;
  if (/no crontab/i.test(result.stderr)) return null;
  throw fail("E_IO", `crontab -l failed: ${(result.stderr || "crontab is not available").trim()}`);
}

/** @param {string | null} text @param {string} key */
function withoutKey(text, key) {
  return (text ?? "").split("\n").filter((line) => line !== "" && !line.endsWith(`# ${key}`));
}

/**
 * Makes every step of `plan`, recording each in the seat ledger before it is made.
 * @param {Host} host
 * @param {Plan} chosen
 * @param {string} root
 */
export function apply(host, chosen, root) {
  /** @param {string} kind @param {string} target @param {string | null} before @param {Record<string, string>} [extra] */
  const record = (kind, target, before, extra = {}) =>
    recordSeat(host.env, { id: `scheduler:${chosen.key}:${kind}:${target}`, owner: "scheduler", house: root, kind, target, before, ...extra });
  for (const step of chosen.steps) {
    if (step.kind === "file") {
      record("file", step.target, readOrNull(step.target));
      mkdirSync(dirname(step.target), { recursive: true });
      atomicWrite(step.target, step.content);
    } else if (step.kind === "schtasks") {
      const query = host.run("schtasks", ["/Query", "/TN", step.target, "/XML"]);
      record("schtasks", step.target, query.status === 0 ? query.stdout : null);
      must(host, "schtasks", ["/Create", "/TN", step.target, "/TR", step.command, "/SC", "MINUTE", "/MO", String(TICK_MINUTES), "/F"]);
    } else if (step.kind === "systemd-timer") {
      const state = host.run("systemctl", ["--user", "is-enabled", step.target]);
      record("systemd-timer", step.target, state.status === 0 ? state.stdout.trim() : null);
      must(host, "systemctl", ["--user", "daemon-reload"]);
      must(host, "systemctl", ["--user", "enable", "--now", step.target]);
    } else if (step.kind === "crontab") {
      const current = readCrontab(host);
      record("crontab", "crontab", current, { line: step.line });
      must(host, "crontab", ["-"], { input: [...withoutKey(current, chosen.key), step.line, ""].join("\n") });
    } else {
      const loaded = host.run("launchctl", ["print", step.target]).status === 0;
      record("launchd", step.target, loaded ? "loaded" : null);
      if (loaded) must(host, "launchctl", ["bootout", step.target]);
      must(host, "launchctl", ["bootstrap", `gui/${host.uid}`, step.plist]);
    }
  }
}

/**
 * The ledger entries the scheduler recorded for `key`, in the order they were made.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 */
export function recorded(env, key) {
  return readSeat(env).entries.filter((entry) => entry.owner === "scheduler" && entry.id.startsWith(`scheduler:${key}:`));
}

/**
 * Reverses the recorded entries for `key`, newest first, dropping each from the ledger once it is undone.
 * @param {Host} host
 * @param {string} key
 * @returns {string[]} what was undone, one line each
 */
export function revert(host, key) {
  const entries = recorded(host.env, key).reverse();
  /** @type {string[]} */
  const done = [];
  let reload = false;
  /** @type {string | null} */
  let rebootstrap = null;
  for (const entry of entries) {
    if (entry.kind === "schtasks") {
      const present = host.run("schtasks", ["/Query", "/TN", entry.target]).status === 0;
      if (entry.before === null) {
        if (present) must(host, "schtasks", ["/Delete", "/TN", entry.target, "/F"]);
        done.push(`removed Task Scheduler task ${entry.target}`);
      } else {
        const file = join(host.scratch, `${entry.target}.xml`);
        mkdirSync(host.scratch, { recursive: true });
        atomicWrite(file, entry.before, { lf: false });
        try {
          must(host, "schtasks", ["/Create", "/TN", entry.target, "/XML", file, "/F"]);
        } finally {
          rmSync(file, { force: true });
        }
        done.push(`restored Task Scheduler task ${entry.target} to its earlier definition`);
      }
    } else if (entry.kind === "systemd-timer") {
      reload = true;
      if (entry.before === null) {
        if (host.run("systemctl", ["--user", "is-enabled", entry.target]).status === 0) {
          must(host, "systemctl", ["--user", "disable", "--now", entry.target]);
        }
        done.push(`disabled systemd user timer ${entry.target}`);
      } else {
        done.push(`left systemd user timer ${entry.target} ${entry.before}, as it was before`);
      }
    } else if (entry.kind === "crontab") {
      const current = readCrontab(host);
      const kept = withoutKey(current, key);
      if (kept.length === 0 && entry.before === null) {
        if (current !== null) must(host, "crontab", ["-r"]);
      } else {
        must(host, "crontab", ["-"], { input: [...kept, ""].join("\n") });
      }
      done.push("removed the crontab line");
    } else if (entry.kind === "launchd") {
      if (host.run("launchctl", ["print", entry.target]).status === 0) must(host, "launchctl", ["bootout", entry.target]);
      if (entry.before === "loaded") rebootstrap = entry.target;
      done.push(`unloaded launchd agent ${entry.target}`);
    } else if (entry.kind === "file") {
      if (entry.before === null) rmSync(entry.target, { force: true });
      else atomicWrite(entry.target, entry.before, { lf: false });
      done.push(entry.before === null ? `removed file ${entry.target}` : `restored file ${entry.target}`);
    } else {
      throw fail("E_SCHEMA", `the seat ledger holds a scheduler entry of unknown kind ${JSON.stringify(entry.kind)}`);
    }
    dropSeat(host.env, entry.id);
  }
  if (reload) must(host, "systemctl", ["--user", "daemon-reload"]);
  if (rebootstrap !== null) {
    const plist = join(host.home, "Library", "LaunchAgents", `${launchdLabel(key)}.plist`);
    must(host, "launchctl", ["bootstrap", `gui/${host.uid}`, plist]);
  }
  return done;
}

/**
 * Whether the OS currently carries the entry for `key`, judged by the method recorded in the ledger (or, with
 * nothing recorded, the method `enable` would use).
 * @param {Host} host
 * @param {string} key
 * @returns {{ method: Method, registered: boolean }}
 */
export function probe(host, key) {
  const kinds = new Set(recorded(host.env, key).map((entry) => entry.kind));
  /** @type {Method} */
  const method =
    host.platform === "win32"
      ? "schtasks"
      : host.platform === "darwin"
        ? "launchd"
        : kinds.has("crontab")
          ? "crontab"
          : kinds.has("systemd-timer") || systemdAvailable(host)
            ? "systemd"
            : "crontab";
  if (method === "schtasks") return { method, registered: host.run("schtasks", ["/Query", "/TN", key]).status === 0 };
  if (method === "launchd") return { method, registered: host.run("launchctl", ["print", launchdTarget(host, key)]).status === 0 };
  if (method === "systemd") {
    return { method, registered: host.run("systemctl", ["--user", "is-enabled", `${key}.timer`]).status === 0 };
  }
  const result = host.run("crontab", ["-l"]);
  return { method, registered: result.status === 0 && result.stdout.split("\n").some((line) => line.endsWith(`# ${key}`)) };
}
