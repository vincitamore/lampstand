// @ts-check
// house.toml (the house's manifest, validated against schema/house.schema.json) and the per-user config.toml
// (default_house and per-house state_dir overrides). Both are parsed by lampstand's own strict TOML subset.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fail } from "./errors.js";
import { readText } from "./io.js";
import { parseToml } from "./parse/toml.js";

/** @typedef {import("./parse/toml.js").TomlTable} TomlTable */
/** @typedef {import("./parse/toml.js").TomlValue} TomlValue */
/** @typedef {NodeJS.ProcessEnv} Env */

/**
 * The subset of JSON Schema lampstand validates with.
 * @typedef {{
 *   type?: "object" | "array" | "string" | "integer" | "number" | "boolean",
 *   required?: string[],
 *   properties?: Record<string, Schema>,
 *   additionalProperties?: boolean | Schema,
 *   items?: Schema,
 *   enum?: unknown[],
 *   minimum?: number,
 *   maximum?: number,
 *   minLength?: number,
 *   maxLength?: number,
 *   pattern?: string,
 *   description?: string,
 * }} Schema
 */

/**
 * @typedef {{
 *   house: { schema: number, id: string, name: string },
 *   operator?: { name?: string, co_owners?: string[] },
 *   purpose?: { text?: string },
 *   charter?: { mode?: "none" | "rules" | "agreement" },
 *   budget?: { profile?: "lean" | "standard" | "large" },
 *   modules?: { scheduler?: boolean, rooms?: boolean, residents?: boolean, watchdog?: boolean, orchestration?: boolean },
 *   gate?: { mode?: "off" | "remind" | "block" },
 *   plugin?: { min?: string },
 *   packs?: { principles?: string },
 *   surfaces?: Record<string, { role?: string, loads?: "always" | "session" | "subagent" | "on-demand", cap?: number }>,
 *   reflexes?: { router?: "index" | "full" },
 * }} HouseConfig
 */

/** @typedef {{ default_house?: string, houses?: Record<string, { state_dir?: string }> }} UserConfig */

export const HOUSE_SCHEMA = /** @type {Schema} */ (
  JSON.parse(readFileSync(new URL("../../schema/house.schema.json", import.meta.url), "utf8"))
);
// [org] is described in schema/org.json (its house_toml entry), the single source the org substrate owns.
/** @type {Record<string, Schema>} */ (HOUSE_SCHEMA.properties).org = /** @type {Schema} */ (
  JSON.parse(readFileSync(new URL("../../schema/org.json", import.meta.url), "utf8")).house_toml
);
// [jobs.<id>] tables are described in their own schema file, the single source write governance owns; the
// validator has no $ref, so the table is attached here at load.
/** @type {Record<string, Schema>} */ (HOUSE_SCHEMA.properties).jobs = /** @type {Schema} */ (
  JSON.parse(readFileSync(new URL("../../schema/jobs.schema.json", import.meta.url), "utf8"))
);


/** The newest house.schema version this code understands: the schema file's maximum for house.schema. */
export const HOUSE_SCHEMA_VERSION = /** @type {number} */ (HOUSE_SCHEMA.properties?.house.properties?.schema.maximum);

/** @type {Schema} */
export const USER_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    default_house: { type: "string", minLength: 1 },
    houses: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: { state_dir: { type: "string", minLength: 1 } },
      },
    },
  },
};

/**
 * The per-user config root: LAMPSTAND_CONFIG_ROOT when set, else %APPDATA% on Windows, ~/Library/Application Support
 * on macOS, $XDG_CONFIG_HOME or ~/.config elsewhere. lampstand's files live in `<root>/lampstand/`.
 * @param {Env} [env]
 */
export function configRoot(env = process.env) {
  const override = env.LAMPSTAND_CONFIG_ROOT;
  if (override) {
    if (!isAbsolute(override)) throw fail("E_ENV_INVALID", `LAMPSTAND_CONFIG_ROOT must be an absolute path, got ${JSON.stringify(override)}`);
    return override;
  }
  if (process.platform === "win32") return env.APPDATA || join(homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  const xdg = env.XDG_CONFIG_HOME;
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
}

/** @param {Env} [env] */
export function userConfigPath(env = process.env) {
  return join(configRoot(env), "lampstand", "config.toml");
}

/**
 * The per-user config, or `{}` when the file does not exist.
 * @param {Env} [env]
 * @returns {UserConfig}
 */
export function loadUserConfig(env = process.env) {
  const path = userConfigPath(env);
  if (!existsSync(path)) return {};
  const lines = new Map();
  const data = parseToml(readText(path), path, { lines });
  validate(USER_CONFIG_SCHEMA, data, path, lines);
  return /** @type {UserConfig} */ (data);
}

/**
 * Reads, parses and validates `<root>/house.toml`. A house.schema newer than this code understands is refused
 * before any other check, since a newer schema may legitimately carry keys this one rejects.
 * @param {string} root
 * @returns {HouseConfig}
 */
export function loadHouseConfig(root) {
  const path = join(root, "house.toml");
  return parseHouseToml(readText(path), path);
}

/**
 * @param {string} text
 * @param {string} path
 * @returns {HouseConfig}
 */
export function parseHouseToml(text, path) {
  const lines = new Map();
  const data = parseToml(text, path, { lines });
  const house = data.house;
  const version = isTable(house) ? house.schema : undefined;
  if (typeof version === "number" && Number.isInteger(version) && version > HOUSE_SCHEMA_VERSION) {
    throw fail(
      "E_SCHEMA_NEWER",
      `house.schema = ${version} is newer than this lampstand understands (${HOUSE_SCHEMA_VERSION}); upgrade lampstand before using this house`,
      { path, line: lines.get(JSON.stringify(["house", "schema"])) },
    );
  }
  validate(HOUSE_SCHEMA, data, path, lines);
  return /** @type {HouseConfig} */ (/** @type {unknown} */ (data));
}

/** @param {unknown} value @returns {value is TomlTable} */
function isTable(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates `value` against `schema`, throwing E_SCHEMA at the first violation with the dotted key and, when
 * known, the line of the nearest enclosing key.
 * @param {Schema} schema
 * @param {unknown} value
 * @param {string} path  file named in the error
 * @param {Map<string, number>} [lines]  key path (JSON) to line, as filled by parseToml
 */
export function validate(schema, value, path, lines) {
  const problem = check(schema, value, []);
  if (!problem) return;
  let line;
  for (let n = problem.at.length; n > 0 && line === undefined; n--) {
    line = lines?.get(JSON.stringify(problem.at.slice(0, n).filter((key) => typeof key === "string")));
  }
  const where = problem.at.length === 0 ? "the document" : renderPath(problem.at);
  throw fail("E_SCHEMA", `${where} ${problem.reason}`, { path, line });
}

/** @param {(string | number)[]} at */
function renderPath(at) {
  let out = "";
  for (const key of at) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out === "" ? key : `.${key}`;
  }
  return out;
}

/** @param {unknown} value */
function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
  if (typeof value === "object") return "table";
  return typeof value;
}

/**
 * @param {Schema} schema
 * @param {unknown} value
 * @param {(string | number)[]} at
 * @returns {{ at: (string | number)[], reason: string } | null}
 */
function check(schema, value, at) {
  const t = schema.type;
  if (t !== undefined) {
    const ok =
      t === "object"
        ? isTable(value)
        : t === "array"
          ? Array.isArray(value)
          : t === "integer"
            ? Number.isInteger(value)
            : t === "number"
              ? typeof value === "number"
              : typeof value === t;
    if (!ok) return { at, reason: `must be ${t === "object" ? "a table" : `of type ${t}`}, found ${typeName(value)}` };
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return { at, reason: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}, found ${JSON.stringify(value)}` };
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return { at, reason: `must be at least ${schema.minimum}` };
    if (schema.maximum !== undefined && value > schema.maximum) return { at, reason: `must be at most ${schema.maximum}` };
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return { at, reason: `must be at least ${schema.minLength} characters` };
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return { at, reason: `must be at most ${schema.maxLength} characters, found ${length}` };
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      return { at, reason: `must match ${schema.pattern}, found ${JSON.stringify(value)}` };
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let k = 0; k < value.length; k++) {
      const problem = check(schema.items, value[k], [...at, k]);
      if (problem) return problem;
    }
  }
  if (isTable(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return { at, reason: `is missing required key ${key}` };
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const problem = check(properties[key], item, [...at, key]);
        if (problem) return problem;
      } else if (schema.additionalProperties === false) {
        return { at: [...at, key], reason: "is not a known key" };
      } else if (typeof schema.additionalProperties === "object") {
        const problem = check(schema.additionalProperties, item, [...at, key]);
        if (problem) return problem;
      }
    }
  }
  return null;
}

/**
 * True when `dir` holds a regular file named house.toml.
 * @param {string} dir
 */
export function hasHouseToml(dir) {
  try {
    return statSync(join(dir, "house.toml")).isFile();
  } catch {
    return false;
  }
}
