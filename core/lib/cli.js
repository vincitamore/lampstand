// @ts-check
// The CLI contract for every verb: `lampstand <verb> [args] [--json]`. With --json, stdout is exactly one JSON object
// whose first key is `ok`. Exit codes: 0 clean, 1 actionable finding, 2 could not run, 64 usage, 70 internal.
// Verbs are registered into a Registry; dispatch never names a verb, so adding one is a register() call.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ERROR_CODES, LampstandError, fail, isLampstandError } from "./errors.js";

/**
 * @typedef {{ type: "boolean" | "string", summary: string }} FlagSpec
 * @typedef {{
 *   args: string[],
 *   flags: Record<string, boolean | string>,
 *   json: boolean,
 *   env: NodeJS.ProcessEnv,
 *   cwd: string,
 * }} VerbContext
 * @typedef {{ ok?: boolean, exit?: 0 | 1 | 2 | 3, data?: Record<string, unknown>, text: string }} VerbResult
 * @typedef {{
 *   name: string,
 *   summary: string,
 *   flags?: Record<string, FlagSpec>,
 *   args?: { min: number, max: number, usage: string },
 *   more?: (args: string[]) => string,
 *   groupNote?: () => string,
 *   run: (context: VerbContext) => VerbResult | Promise<VerbResult>,
 * }} Verb
 * @typedef {{ write(text: string): unknown }} Sink
 * @typedef {{ stdout: Sink, stderr: Sink, env: NodeJS.ProcessEnv, cwd: string }} CliIo
 */

export class Registry {
  constructor() {
    /** @type {Map<string, Verb>} */
    this.verbs = new Map();
  }

  /** @param {Verb[]} verbs */
  register(...verbs) {
    for (const verb of verbs) {
      if (!/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/.test(verb.name)) throw new Error(`invalid verb name ${JSON.stringify(verb.name)}`);
      if (this.verbs.has(verb.name)) throw new Error(`verb ${JSON.stringify(verb.name)} is registered twice`);
      for (const flag of Object.keys(verb.flags ?? {})) {
        if (flag === "json" || flag === "help") throw new Error(`verb ${verb.name} redefines the global flag --${flag}`);
      }
      this.verbs.set(verb.name, verb);
    }
    return this;
  }

  /**
   * The verb named by the longest run of leading words, and the words left over.
   * @param {string[]} words
   * @returns {{ verb: Verb, rest: string[] } | null}
   */
  match(words) {
    for (let n = words.length; n > 0; n--) {
      const verb = this.verbs.get(words.slice(0, n).join(" "));
      if (verb) return { verb, rest: words.slice(n) };
    }
    return null;
  }

  /**
   * The subcommands under a command group (`decide` holds `decide new` and `decide resolve`), with their summaries, and
   * the group's name; null when no verb is registered under the longest leading run of `words`.
   * @param {string[]} words
   * @returns {{ group: string, text: string } | null}
   */
  group(words) {
    for (let n = words.length; n > 0; n--) {
      const group = words.slice(0, n).join(" ");
      const subs = [...this.verbs.keys()].filter((name) => name.startsWith(`${group} `)).sort();
      if (subs.length === 0) continue;
      const width = Math.max(...subs.map((name) => name.length));
      const lines = subs.map((name) => `  ${name.padEnd(width)}  ${/** @type {Verb} */ (this.verbs.get(name)).summary}`);
      const notes = subs.map((name) => /** @type {Verb} */ (this.verbs.get(name)).groupNote?.()).filter((note) => note !== undefined);
      const tail = [`lampstand ${group} <subcommand> --help shows a subcommand's flags.`, ...notes].join("\n\n");
      return { group, text: `usage: lampstand ${group} <subcommand> [args] [--json]\n\nsubcommands:\n${lines.join("\n")}\n\n${tail}` };
    }
    return null;
  }

  usage() {
    const names = [...this.verbs.keys()].sort();
    const width = Math.max(0, ...names.map((name) => name.length));
    const lines = names.map((name) => `  ${name.padEnd(width)}  ${/** @type {Verb} */ (this.verbs.get(name)).summary}`);
    return `usage: lampstand <verb> [args] [--json]\n\nverbs:\n${lines.join("\n")}`;
  }
}

/**
 * @param {Verb} verb
 * @param {string[]} [args]  the positional arguments given with --help, which `more` may use
 * @param {Registry} [registry]  when the verb is also a command group, its subcommands are listed
 */
function verbUsage(verb, args = [], registry) {
  const flags = Object.entries(verb.flags ?? {}).map(
    ([name, spec]) => `  --${name}${spec.type === "string" ? " <value>" : ""}  ${spec.summary}`,
  );
  flags.push("  --json  print one JSON object whose first key is ok");
  const subs = registry?.group([verb.name]);
  const more = `${verb.more ? `\n\n${verb.more(args)}` : ""}${subs ? `\n\n${subs.text.slice(subs.text.indexOf("subcommands:"))}` : ""}`;
  return `usage: lampstand ${verb.name}${verb.args ? ` ${verb.args.usage}` : ""} [flags]\n\n${verb.summary}\n\nflags:\n${flags.join("\n")}${more}`;
}

/**
 * Splits argv into words and flags. `--name=value` and `--name value` both set string flags; `--` ends flags.
 * @param {string[]} argv
 * @param {Registry} registry
 */
function parseArgv(argv, registry) {
  const json = hasGlobal(argv, "--json");
  const help = hasGlobal(argv, "--help") || hasGlobal(argv, "-h");
  const words = [];
  let k = 0;
  for (; k < argv.length; k++) {
    const token = argv[k];
    if (token === "--json" || token === "--help" || token === "-h") continue;
    if (token.startsWith("-")) break;
    words.push(token);
  }
  const found = registry.match(words);
  if (!found) return { json, help, verb: null, words };
  const { verb, rest } = found;
  const specs = verb.flags ?? {};
  /** @type {Record<string, boolean | string>} */
  const flags = {};
  const args = [...rest];
  let flagsDone = false;
  for (; k < argv.length; k++) {
    const token = argv[k];
    if (flagsDone || !token.startsWith("-") || token === "-") {
      args.push(token);
      continue;
    }
    if (token === "--") {
      flagsDone = true;
      continue;
    }
    if (token === "--json" || token === "--help" || token === "-h") continue;
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(token);
    const spec = match ? specs[match[1]] : undefined;
    if (!match || !spec) throw fail("E_USAGE", `unknown flag ${token} for lampstand ${verb.name}`);
    const [, name, inline] = match;
    if (spec.type === "boolean") {
      if (inline !== undefined) throw fail("E_USAGE", `--${name} takes no value`);
      flags[name] = true;
    } else if (inline !== undefined) {
      flags[name] = inline;
    } else {
      if (k + 1 >= argv.length) throw fail("E_USAGE", `--${name} needs a value`);
      flags[name] = argv[++k];
    }
  }
  const bounds = verb.args ?? { min: 0, max: 0, usage: "" };
  if (!help && (args.length < bounds.min || args.length > bounds.max)) {
    throw fail(
      "E_USAGE",
      args.length > bounds.max
        ? `unexpected argument ${JSON.stringify(args[bounds.max])} for lampstand ${verb.name}`
        : `lampstand ${verb.name} needs ${bounds.usage}`,
    );
  }
  return { json, help, verb, words, args, flags };
}

/** True when `flag` appears before any `--` terminator. @param {string[]} argv @param {string} flag */
function hasGlobal(argv, flag) {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).includes(flag);
}

/**
 * Runs one CLI invocation and returns its exit code. Never throws.
 * @param {Registry} registry
 * @param {string[]} argv  arguments after the program name
 * @param {CliIo} io
 * @returns {Promise<number>}
 */
export async function runCli(registry, argv, io) {
  const json = hasGlobal(argv, "--json");
  try {
    const parsed = parseArgv(argv, registry);
    if (!parsed.verb) {
      if (parsed.help && parsed.words.length === 0) {
        emit(io, json, { ok: true, usage: registry.usage() }, registry.usage());
        return 0;
      }
      const group = registry.group(parsed.words);
      if (group && parsed.help) {
        emit(io, json, { ok: true, usage: group.text }, group.text);
        return 0;
      }
      if (group) {
        const bare = parsed.words.length === group.group.split(" ").length;
        const why = bare ? `lampstand ${group.group} needs a subcommand` : `unknown subcommand ${JSON.stringify(parsed.words.join(" "))}`;
        throw fail("E_USAGE", json ? why : `${why}\n\n${group.text}`);
      }
      const reason = parsed.words.length === 0 ? "no verb given" : `unknown verb ${JSON.stringify(parsed.words.join(" "))}`;
      throw fail("E_USAGE", json ? reason : `${reason}\n\n${registry.usage()}`);
    }
    const verb = parsed.verb;
    if (parsed.help) {
      const usage = verbUsage(verb, parsed.args, registry);
      emit(io, json, { ok: true, usage }, usage);
      return 0;
    }
    const result = await verb.run({
      args: parsed.args ?? [],
      flags: parsed.flags ?? {},
      json,
      env: io.env,
      cwd: io.cwd,
    });
    emit(io, json, { ok: result.ok ?? true, ...result.data }, result.text);
    return result.exit ?? 0;
  } catch (error) {
    return report(io, json, error);
  }
}

/**
 * @param {CliIo} io
 * @param {boolean} json
 * @param {{ ok: boolean } & Record<string, unknown>} envelope
 * @param {string} text
 */
function emit(io, json, envelope, text) {
  if (json) io.stdout.write(`${JSON.stringify(envelope)}\n`);
  else if (text !== "") io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * @param {CliIo} io
 * @param {boolean} json
 * @param {unknown} error
 * @returns {number}
 */
function report(io, json, error) {
  const known = isLampstandError(error);
  const failure = known
    ? error
    : new LampstandError("E_INTERNAL", error instanceof Error ? error.message : String(error), { cause: error });
  if (!known) io.stderr.write(`${error instanceof Error && error.stack ? error.stack : String(error)}\n`);
  if (json) {
    /** @type {Record<string, unknown>} */
    const detail = { code: failure.code, message: failure.message };
    if (failure.path !== undefined) detail.path = failure.path;
    if (failure.line !== undefined) detail.line = failure.line;
    io.stdout.write(`${JSON.stringify({ ok: false, error: detail })}\n`);
  } else {
    io.stderr.write(`lampstand: ${failure.code}: ${failure.message}\n`);
  }
  return ERROR_CODES[failure.code].exit;
}

const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

/** @type {Verb} */
export const versionVerb = {
  name: "version",
  summary: "print the lampstand version and the runtime running it",
  run() {
    const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
    return {
      data: { version: PACKAGE.version, runtime },
      text: `lampstand ${PACKAGE.version} (${runtime})`,
    };
  },
};

/**
 * Asks one yes/no question on stderr and reads one line from stdin; end of input is no. Shared by every verb that
 * lists what it will change and asks once.
 * @param {string} question
 */
export async function askOnce(question) {
  process.stderr.write(question);
  const lines = createInterface({ input: process.stdin, terminal: false });
  try {
    let answered = false;
    const answer = await new Promise((resolve) => {
      lines.once("line", (line) => {
        answered = true;
        resolve(line);
      });
      lines.once("close", () => {
        if (answered) return;
        process.stderr.write("\n");
        resolve("");
      });
    });
    return /^y(?:es)?$/i.test(String(answer).trim());
  } finally {
    lines.close();
  }
}
