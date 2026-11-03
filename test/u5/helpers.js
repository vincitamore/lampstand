// @ts-check
// A stub OMP host: it records what the extension factory registers and lets a test emit events to it the way OMP
// does, with a context per session kind. The adapter reads process.env (HOUSE_ROOT, the state and config roots), so
// `isolateProcessEnv` points those at temp directories for the duration of a test.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv } from "../u1/helpers.js";

/** @typedef {{ after(fn: () => void): void }} TestContext */
/** @typedef {{ message: { customType: string, content: string, display: boolean }, options?: { deliverAs?: string } }} Sent */
/** @typedef {{ text: string, level?: string }} Note */

/** The adapter module, loaded the way OMP's Bun loader and Node's type stripping both can. */
export async function loadAdapter() {
  return await import(new URL("../../hosts/omp/index.ts", import.meta.url).href);
}

/** A fresh real-path temp directory removed when the test ends. @param {TestContext} t */
export function tempDir(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-u5-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/**
 * Replaces process.env with an isolated copy (temp state and config roots, no HOUSE_ROOT) until the test ends.
 * @param {TestContext} t
 * @param {string} dir
 */
export function isolateProcessEnv(t, dir) {
  const saved = { ...process.env };
  const env = isolatedEnv(dir);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
}
/**
 * Loads the factory against a stub host. `version` is what the host reports as `pi.pi.VERSION`; when the key is
 * absent from `options` a current OMP is reported, and `{ version: undefined }` is a host that reports none.
 * @param {{ version?: string }} [options]
 */
export async function stubHost(options = {}) {
  const version = "version" in options ? options.version : "18.15.0";
  const { default: factory } = await loadAdapter();
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  /** @type {Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>} */
  const commands = new Map();
  /** @type {Sent[]} */
  const sent = [];
  const api = {
    pi: version === undefined ? {} : { VERSION: version },
    /** @param {string} event @param {Function} handler */
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    /** @param {string} name @param {{ handler: (args: string, ctx: unknown) => Promise<void> }} options */
    registerCommand(name, options) {
      commands.set(name, options);
    },
    /** @param {Sent["message"]} message @param {Sent["options"]} [options] */
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  await factory(api);
  return {
    handlers,
    commands,
    sent,
    /** The event names registered, sorted. */
    events: () => [...handlers.keys()].sort(),
    /**
     * Emits `event` to every handler in registration order and returns the last defined result.
     * @param {string} event @param {unknown} payload @param {unknown} ctx
     */
    async emit(event, payload, ctx) {
      let last;
      for (const handler of handlers.get(event) ?? []) {
        const result = await handler(payload, ctx);
        if (result !== undefined) last = result;
      }
      return last;
    },
  };
}

/**
 * A handler context for a session of `kind` in `cwd`, recording notices.
 * @param {string} cwd
 * @param {"main" | "sub"} [kind]
 */
export function session(cwd, kind = "main") {
  /** @type {Note[]} */
  const notes = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      /** @param {string} text @param {string} [level] */
      notify: (text, level) => void notes.push({ text, level }),
      select: async () => undefined,
    },
    agent: { kind },
  };
  return { ctx, notes };
}
