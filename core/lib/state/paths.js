// @ts-check
// Where a house's per-machine state lives:
//
//   <state root>/lampstand/<house-id>-<sha8(realpath root)>/house.db
//
// The state root is %LOCALAPPDATA% on Windows, ~/Library/Application Support on macOS, and $XDG_STATE_HOME
// (fallback ~/.local/state) elsewhere. The realpath hash keeps two clones of one house on one machine apart.
// Per-user config may override the directory for one house:
//
//   [houses."<house-id>"]
//   state_dir = "/absolute/path"
//
// Environment overrides, honoured everywhere (tests point both at temp directories so nothing touches real roots):
//   LAMPSTAND_STATE_ROOT   replaces the platform state root; state goes to $LAMPSTAND_STATE_ROOT/lampstand/...
//   LAMPSTAND_CONFIG_ROOT  replaces the platform config root; config is $LAMPSTAND_CONFIG_ROOT/lampstand/config.toml
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadUserConfig, userConfigPath } from "../config.js";
import { fail } from "../errors.js";

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function stateRoot(env = process.env) {
  const override = env.LAMPSTAND_STATE_ROOT;
  if (override) {
    if (!isAbsolute(override)) throw fail("E_ENV_INVALID", `LAMPSTAND_STATE_ROOT must be an absolute path, got ${JSON.stringify(override)}`);
    return override;
  }
  if (process.platform === "win32") return env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  const xdg = env.XDG_STATE_HOME;
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
}

/** First 8 hex digits of sha256 over the UTF-8 real path. @param {string} root */
export function rootHash(root) {
  return createHash("sha256").update(realpathSync.native(root), "utf8").digest("hex").slice(0, 8);
}

/**
 * The state directory for the house at `root` whose house.toml id is `houseId`. Does not create it.
 * @param {string} root
 * @param {string} houseId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ dir: string, source: "default" | "config" }}
 */
export function stateDirFor(root, houseId, env = process.env) {
  const override = loadUserConfig(env).houses?.[houseId]?.state_dir;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw fail("E_SCHEMA", `houses.${JSON.stringify(houseId)}.state_dir must be an absolute path, got ${JSON.stringify(override)}`, {
        path: userConfigPath(env),
      });
    }
    return { dir: override, source: "config" };
  }
  return { dir: join(stateRoot(env), "lampstand", `${houseId}-${rootHash(root)}`), source: "default" };
}
