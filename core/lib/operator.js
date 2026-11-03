// @ts-check
// Acts that belong to the operator, not to the agent working in the house. Each host adapter marks its agent's
// environment (hosts/omp/index.ts, hosts/hermes/plugin.py), and the shell the agent's tool runs commands in inherits
// the mark, so a verb can tell an agent's shell from the operator's terminal.
import { fail } from "./errors.js";

/** The variable the host adapters set in their agent's environment. */
export const AGENT_ENV = "LAMPSTAND_AGENT";

/** True when `env` is an agent's shell. @param {NodeJS.ProcessEnv} env */
export function isAgentShell(env) {
  return (env[AGENT_ENV] ?? "") !== "";
}

/**
 * Refuses an act reserved for the operator when it is asked for from an agent's shell.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} act  what was asked, as the message names it (`lampstand scheduler enable`)
 * @param {string} routes  where the operator does it (`in a terminal`)
 */
export function requireOperator(env, act, routes) {
  if (isAgentShell(env)) throw fail("E_OPERATOR_ONLY", `${act} waits for the operator: ${routes}`);
}
