// @ts-check
// Every stable error code, defined once. Docs are generated from ERROR_CODES, so each meaning is one line.
// Exit codes follow the CLI contract: 1 actionable finding, 2 could not run (infrastructure), 64 usage, 70 internal.

/** @typedef {1 | 2 | 64 | 70} ExitCode */
/** @typedef {{ exit: ExitCode, meaning: string }} ErrorSpec */

export const ERROR_CODES = Object.freeze(/** @satisfies {Record<string, ErrorSpec>} */ ({
  E_USAGE: { exit: 64, meaning: "The command line names an unknown verb or carries an unknown or malformed argument." },
  E_HOUSE_ROOT_INVALID: { exit: 1, meaning: "HOUSE_ROOT is set but the directory it names holds no house.toml." },
  E_DEFAULT_HOUSE_INVALID: {
    exit: 1,
    meaning: "default_house in per-user config is not an absolute path to a directory holding house.toml.",
  },
  E_ENV_INVALID: {
    exit: 1,
    meaning: "An environment variable lampstand reads holds an unusable value, such as a relative path for a root override.",
  },
  E_NO_HOUSE: { exit: 1, meaning: "The verb needs a house and none was resolved: the plugin is dormant here." },
  E_PARSE_TOML: { exit: 1, meaning: "A TOML file is malformed or uses a construct outside lampstand's TOML subset." },
  E_PARSE_FRONTMATTER: {
    exit: 1,
    meaning: "A Markdown frontmatter block is malformed or uses a construct outside lampstand's YAML subset.",
  },
  E_SCHEMA: { exit: 1, meaning: "A configuration file parses but does not match its schema." },
  E_PLUGIN_TOO_OLD: {
    exit: 1,
    meaning: "house.toml [plugin] min names a lampstand newer than this one; upgrade lampstand before using this house.",
  },
  E_SCHEMA_NEWER: {
    exit: 1,
    meaning: "house.toml declares a house.schema version newer than this lampstand understands; upgrade lampstand.",
  },
  E_STATE_SCHEMA_NEWER: {
    exit: 1,
    meaning: "house.db was migrated by a newer lampstand than this one; upgrade lampstand.",
  },
  E_STATE_DIR: { exit: 2, meaning: "The per-machine state directory cannot be created or is not a directory." },
  E_STATE_DB: { exit: 2, meaning: "house.db cannot be opened, switched to WAL, or migrated." },
  E_SQLITE_UNAVAILABLE: { exit: 2, meaning: "Neither bun:sqlite nor node:sqlite is available in this runtime." },
  E_IO: { exit: 2, meaning: "A file could not be read or written." },
  E_JOB_UNKNOWN: { exit: 64, meaning: "lampstand run names a job that house.toml [jobs] does not declare." },
  E_SCHEDULER: { exit: 2, meaning: "An OS scheduler command (schtasks, systemctl, crontab, launchctl) failed." },
  E_INTERNAL: { exit: 70, meaning: "lampstand hit a bug: an unexpected exception escaped a verb." },
}));

/** @typedef {keyof typeof ERROR_CODES} ErrorCode */

export class LampstandError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message
   * @param {{ path?: string, line?: number, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "LampstandError";
    /** @type {ErrorCode} */
    this.code = code;
    /** @type {string | undefined} */
    this.path = extra.path;
    /** @type {number | undefined} */
    this.line = extra.line;
  }

  /** @returns {ExitCode} */
  get exitCode() {
    return ERROR_CODES[this.code].exit;
  }
}

/**
 * Builds an error whose message leads with `path:line:` when they are known, so a refusal names its file.
 * @param {ErrorCode} code
 * @param {string} reason
 * @param {{ path?: string, line?: number, cause?: unknown }} [extra]
 */
export function fail(code, reason, extra = {}) {
  const where = extra.path === undefined ? "" : extra.line === undefined ? `${extra.path}: ` : `${extra.path}:${extra.line}: `;
  return new LampstandError(code, `${where}${reason}`, extra);
}

/** @param {unknown} value @returns {value is LampstandError} */
export function isLampstandError(value) {
  return value instanceof LampstandError;
}
