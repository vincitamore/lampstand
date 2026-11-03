// @ts-check
// Commits exactly the paths a verb wrote, so a plant or an adoption lands as one commit and the operator's own
// staged and unstaged work stays out of it. The paths are named by the caller, never discovered with `git status`.
// When git cannot commit (not installed, not a work tree, no identity, a hook refusing) nothing is lost: the files
// stay as written and the outcome says why and gives the command to run by hand.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "./io.js";
import { spawnResolved } from "./governance/spawn.js";

/**
 * @typedef {{ status: "committed", sha: string }
 *   | { status: "nothing" }
 *   | { status: "uncommitted", reason: string, command: string | null }} CommitOutcome
 *   command: what the operator runs once the reason is dealt with, or null when git itself is missing
 */

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} args
 * @param {string} [input]
 */
function git(root, env, args, input) {
  try {
    const result = spawnResolved("git", args, {
      cwd: root,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      windowsHide: true,
      ...(input === undefined ? {} : { input }),
    });
    if (result.error) return { ok: false, missing: /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT", stdout: "", stderr: result.error.message };
    return { ok: result.status === 0, missing: false, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "").trim() };
  } catch (error) {
    return { ok: false, missing: false, stdout: "", stderr: errorMessage(error) };
  }
}

/** A path as a shell argument: bare when it is plain, double-quoted otherwise. @param {string} path */
function shellWord(path) {
  return /^[\w./@+-]+$/.test(path) ? path : `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

/**
 * The command that stages `paths` and commits only them.
 * @param {string[]} paths
 * @param {string} message
 */
export function commitCommand(paths, message) {
  const list = paths.map(shellWord).join(" ");
  return `git add -- ${list} && git commit --only -m ${shellWord(message)} -- ${list}`;
}

/**
 * Stages `paths` (house-relative, `/`-separated) and commits only them. A path that no longer exists is part of the
 * commit only when git tracks it (a deletion); a path that never existed is skipped.
 * @param {string} root  the house root, which may lie inside a larger repository
 * @param {string[]} paths
 * @param {string} message
 * @param {NodeJS.ProcessEnv} env
 * @returns {CommitOutcome}
 */
export function commitOnly(root, paths, message, env) {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return { status: "nothing" };
  const inside = git(root, env, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.missing) return { status: "uncommitted", reason: "git is not installed", command: null };
  if (!inside.ok || inside.stdout.trim() !== "true") return { status: "uncommitted", reason: "the house is not in a git repository", command: null };
  const command = commitCommand(unique, message);
  for (const kind of ["AUTHOR", "COMMITTER"]) {
    if (!git(root, env, ["var", `GIT_${kind}_IDENT`]).ok) {
      return { status: "uncommitted", reason: "git has no user.name and user.email to sign with", command };
    }
  }
  const gone = unique.filter((path) => !existsSync(join(root, ...path.split("/"))));
  const tracked = new Set(gone.length === 0 ? [] : git(root, env, ["--literal-pathspecs", "ls-files", "-z", "--", ...gone]).stdout.split("\0").filter(Boolean));
  const named = unique.filter((path) => !gone.includes(path) || tracked.has(path));
  if (named.length === 0) return { status: "nothing" };
  const pathspec = `--pathspec-from-file=-`;
  const nul = "--pathspec-file-nul";
  const input = named.join("\0");
  const added = git(root, env, ["--literal-pathspecs", "add", pathspec, nul], input);
  if (!added.ok) return { status: "uncommitted", reason: `git add refused the paths: ${added.stderr || "no message"}`, command };
  const before = git(root, env, ["rev-parse", "-q", "--verify", "HEAD"]);
  const committed = git(root, env, ["--literal-pathspecs", "commit", "--only", "-q", "-m", message, pathspec, nul], input);
  if (!committed.ok) {
    if (/nothing (added )?to commit|no changes added to commit/.test(committed.stdout)) return { status: "nothing" };
    const why = (committed.stderr || committed.stdout.trim() || "no message").split("\n")[0];
    return { status: "uncommitted", reason: `git commit was refused: ${why}`, command };
  }
  const now = git(root, env, ["rev-parse", "-q", "--verify", "HEAD"]);
  const sha = now.ok ? now.stdout.trim() : "";
  if (sha === "" || (before.ok && sha === before.stdout.trim())) {
    return { status: "uncommitted", reason: "git commit reported success but HEAD did not move", command };
  }
  return { status: "committed", sha };
}

/**
 * One line telling what became of the commit.
 * @param {CommitOutcome} outcome
 * @param {string} message
 */
export function commitLine(outcome, message) {
  if (outcome.status === "committed") return `git: committed ${outcome.sha.slice(0, 7)} "${message}"`;
  if (outcome.status === "nothing") return "git: nothing to commit";
  return `git: left uncommitted (${outcome.reason})${outcome.command === null ? "" : `; to commit: ${outcome.command}`}`;
}
