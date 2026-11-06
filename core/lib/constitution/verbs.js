// @ts-check
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { commitLine, commitOnly } from "../commit.js";
import { fail } from "../errors.js";
import { isAgentShell } from "../operator.js";
import { WORKSPACE_FLAGS, resolveHouse } from "../root.js";
import { propose, sizeLine, today } from "./curate.js";
import { proposeHelp } from "./examples.js";
import { KINDS } from "./parse.js";
import { actPathsAny, adoptAny, listAllProposals, strikeAny } from "./updates.js";
import { runCompile } from "./run.js";

/** @typedef {import("../cli.js").VerbContext} VerbContext */
/** @typedef {import("../cli.js").VerbResult} VerbResult */
/** @typedef {import("./curate.js").ProposedItem} ProposedItem */
/** @typedef {import("./rules.js").Finding} Finding */

/** Kinds only the operator adopts; reflexes are the one kind an agent may admit. An update replaces a planted file (a charter, the lattice, the curation rules), so it is the operator's too. */
const OPERATOR_KINDS = ["principle/", "provision/", "update/"];

/** @param {string} id */
function operatorOnly(id) {
  return id.startsWith("update/")
    ? `${id} waits for the operator: an update to a planted file is adopted by the operator, in a terminal or with /lampstand adopt`
    : `${id} waits for the operator: principles and provisions are adopted by the operator, in a terminal or with /lampstand adopt`;
}

/** @param {VerbContext} context */
function houseRoot({ env, cwd, flags }) {
  const found = resolveHouse({ env, cwd, workspace: !flags["no-workspace"] });
  if (found.root === null) throw fail("E_NO_HOUSE", `no house resolved from ${resolve(cwd)}`);
  return found.root;
}

/** @param {Finding} finding */
function findingLine(finding) {
  const where = finding.path && !finding.message.startsWith(finding.path) ? ` ${finding.path}:` : "";
  return `${finding.level} [${finding.rule}]${where} ${finding.message}`;
}

/** @param {import("./run.js").CompileRun} run */
function surfaceLines(run) {
  return Object.entries(run.compiled.manifest.surfaces).map(
    ([key, size]) => `  ${key.padEnd(24)} ${String(size.chars).padStart(6)} / ${size.cap} chars (~${size.tokens} tokens)`,
  );
}

/** @type {import("../cli.js").Verb} */
export const compileVerb = {
  name: "compile",
  summary: "compile the constitution into .house/generated/ (with --check: compare only, exit 1 naming each stale projection)",
  flags: {
    ...WORKSPACE_FLAGS,
    check: { type: "boolean", summary: "regenerate in memory and byte-compare with .house/generated/; write nothing" },
  },
  run(context) {
    const root = houseRoot(context);
    const check = context.flags.check === true;
    const run = runCompile(root, { check });
    const ok = run.errors.length === 0;
    const lines = [];
    if (check) {
      lines.push(run.stale.length === 0 ? "projections are fresh" : `stale: ${run.stale.join(", ")}`);
    } else if (ok) {
      lines.push(`compiled .house/generated/ (input-hash ${run.house.inputHash.slice(0, 12)}; profile ${run.house.profile}); ${run.written.length === 0 ? "nothing changed" : `wrote ${run.written.join(", ")}`}`);
    } else {
      lines.push("compile refused: nothing written");
    }
    lines.push(...surfaceLines(run), ...run.findings.map(findingLine));
    return {
      ok,
      exit: ok ? 0 : 1,
      data: {
        house: root,
        profile: run.house.profile,
        inputHash: run.house.inputHash,
        written: run.written,
        stale: run.stale,
        surfaces: run.compiled.manifest.surfaces,
        findings: run.findings,
      },
      text: lines.join("\n"),
    };
  },
};

/**
 * @typedef {{
 *   show(text: string): void,
 *   ask(question: string): Promise<string>,
 *   edit(path: string): boolean,
 * }} Conversation
 *   `edit` opens the file for the operator and returns false when no editor is configured.
 */

/**
 * The interactive adopt loop: each item is shown verbatim with its size against the budget; the answer is adopt,
 * edit, strike or later, and an empty answer is later. Nothing is recommended.
 * @param {string} root
 * @param {Conversation} talk
 * @param {string} date
 */
export async function adoptInteractively(root, talk, date) {
  /** @type {{ id: string, act: string, refused?: string }[]} */
  const acts = [];
  // Taken before any act, so settleActs can undo the run when the compile after it refuses, whichever host called.
  const snapshot = snapshotActs(root, listAllProposals(root));
  SNAPSHOTS.set(acts, snapshot);
  for (const id of listAllProposals(root).map((item) => item.id)) {
    for (;;) {
      const item = listAllProposals(root).find((candidate) => candidate.id === id);
      if (!item) break;
      talk.show(`\n=== ${item.id} (${item.path})\n${item.text}${item.text.endsWith("\n") ? "" : "\n"}--- ${sizeLine(item)}`);
      const answer = (await talk.ask("adopt, edit, strike or later? [later] ")).trim().toLowerCase();
      if (answer === "" || answer === "l" || answer === "later") {
        acts.push({ id, act: "later" });
        break;
      }
      // The proposal as it stands now, after any edit the operator made in this run, is what an undo restores.
      if (["a", "adopt", "s", "strike"].includes(answer)) snapshot.set(item.path, Buffer.from(item.text, "utf8"));
      if (answer === "a" || answer === "adopt") {
        const refused = adoptAny(root, item, date);
        acts.push(refused === null ? { id, act: "adopted" } : { id, act: "refused", refused });
        if (refused !== null) talk.show(`not adopted: ${refused}`);
        break;
      }
      if (answer === "s" || answer === "strike") {
        strikeAny(root, item, date);
        acts.push({ id, act: "struck" });
        break;
      }
      if (answer === "e" || answer === "edit") {
        if (!talk.edit(resolve(root, item.path))) talk.show("no editor: set VISUAL or EDITOR, or edit the file and answer again");
        continue;
      }
      talk.show(`answer adopt, edit, strike or later (got ${JSON.stringify(answer)})`);
    }
  }
  return acts;
}

/**
 * What follows a run of adopt acts: recompile after an adoption, then commit exactly what the run wrote (the record,
 * each moved proposal, the projections) in one commit. Nothing is committed when every item was left for later or
 * refused. When the compile after an adoption refuses, the whole run is undone from `before` (the files the acts
 * touched, as they stood before it) and nothing is committed: an adopted item the compiler rejects would otherwise be
 * committed into a house whose projections can no longer be rebuilt.
 * @param {string} root
 * @param {ProposedItem[]} items  the proposals as they stood before the run
 * @param {{ id: string, act: string }[]} acts
 * @param {NodeJS.ProcessEnv} env
 * @param {Snapshot} [before]  from snapshotActs, taken before the acts ran; adoptInteractively's own is used when absent
 */
export function settleActs(root, items, acts, env, before = SNAPSHOTS.get(acts)) {
  const adopted = acts.filter((act) => act.act === "adopted");
  const struck = acts.filter((act) => act.act === "struck");
  // Proposals and the record are not compiler inputs, so only an adoption makes the projections stale.
  const compiled = adopted.length > 0 ? runCompile(root) : null;
  if (compiled !== null && compiled.errors.length > 0 && before !== undefined) {
    restoreSnapshot(root, before);
    for (const act of acts) {
      if (act.act === "adopted" || act.act === "struck") act.act = "rolled back";
    }
    return { compiled, commit: null, message: "", rolledBack: true };
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  /** @type {string[]} */
  const paths = [];
  for (const [list, act] of /** @type {const} */ ([[adopted, "adopted"], [struck, "struck"]])) {
    for (const { id } of list) paths.push(...actPathsAny(/** @type {ProposedItem} */ (byId.get(id)), act));
  }
  paths.push(...(compiled?.written ?? []));
  const message = [adopted.length > 0 ? `Adopt ${adopted.map((act) => act.id).join(", ")}` : "", struck.length > 0 ? `Strike ${struck.map((act) => act.id).join(", ")}` : ""]
    .filter((part) => part !== "")
    .join("; ");
  const commit = paths.length === 0 ? null : commitOnly(root, paths, message, env);
  return { compiled, commit, message, rolledBack: false };
}

/** @typedef {Map<string, Buffer | null>} Snapshot  house-relative path to its bytes before a run, null when absent */

/** The snapshot adoptInteractively took for the acts list it returned. @type {WeakMap<object, Snapshot>} */
const SNAPSHOTS = new WeakMap();

/**
 * The bytes of every file an adopt or strike of any of `items` could write, move or delete.
 * @param {string} root
 * @param {ProposedItem[]} items
 * @returns {Snapshot}
 */
export function snapshotActs(root, items) {
  /** @type {Snapshot} */
  const out = new Map();
  for (const item of items) {
    for (const rel of [...actPathsAny(item, "adopted"), ...actPathsAny(item, "struck")]) {
      if (out.has(rel)) continue;
      const path = join(root, ...rel.split("/"));
      out.set(rel, existsSync(path) ? readFileSync(path) : null);
    }
  }
  return out;
}

/** Puts every file of `snapshot` back as it was. @param {string} root @param {Snapshot} snapshot */
function restoreSnapshot(root, snapshot) {
  for (const [rel, bytes] of snapshot) {
    const path = join(root, ...rel.split("/"));
    if (bytes === null) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  }
}

/** @param {NodeJS.ProcessEnv} env @param {import("node:readline/promises").Interface} rl @returns {Conversation} */
function terminalConversation(env, rl) {
  return {
    show: (text) => void process.stdout.write(`${text}\n`),
    ask: (question) => rl.question(question),
    edit(path) {
      const editor = env.VISUAL || env.EDITOR;
      if (!editor) return false;
      spawnSync(`${editor} "${path}"`, { shell: true, stdio: "inherit" });
      return true;
    },
  };
}

/** @type {import("../cli.js").Verb} */
export const adoptVerb = {
  name: "adopt",
  summary: "show every proposed item verbatim with its size (including updates to planted files after an upgrade, as update/<path>); adopt, edit, strike or leave it for later (default later); what is adopted or struck is committed",
  flags: {
    ...WORKSPACE_FLAGS,
    ids: { type: "string", summary: "adopt exactly these items, comma-separated, without asking: <kind>/<slug>, or update/<path> for an update to a planted file (update/principles/lattice.md)" },
    strike: { type: "string", summary: "strike exactly these items, comma-separated, without asking (same ids as --ids); a struck item is recorded and its proposal moved aside" },
  },
  async run(context) {
    const root = houseRoot(context);
    const date = today();
    const items = listAllProposals(root);
    /** @type {{ id: string, act: string, refused?: string, code?: string }[]} */
    let acts = [];
    /** @type {Snapshot | undefined} */
    let before;
    const shown = [];
    /** @param {unknown} flag */
    const list = (flag) => (typeof flag === "string" ? flag.split(",").map((id) => id.trim()).filter((id) => id !== "") : null);
    const ids = list(context.flags.ids);
    const strikes = list(context.flags.strike);
    // An agent's shell never gets the interactive loop: answering it would be the agent adopting for the operator.
    const agent = isAgentShell(context.env);
    const interactive = ids === null && strikes === null && !agent && !context.json && process.stdin.isTTY === true && process.stdout.isTTY === true;

    if (interactive) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        acts = await adoptInteractively(root, terminalConversation(context.env, rl), date);
      } finally {
        rl.close();
      }
    } else {
      const named = [...(ids ?? []), ...(strikes ?? [])];
      // With items named, only those are shown: the rest are not this run's business. With none, every proposal is.
      for (const item of items) {
        if (named.length === 0 || named.includes(item.id)) shown.push(`=== ${item.id} (${item.path})\n${item.text}${item.text.endsWith("\n") ? "" : "\n"}--- ${sizeLine(item)}`);
      }
      const byId = new Map(items.map((item) => [item.id, item]));
      const unknown = named.filter((id) => !byId.has(id));
      if (unknown.length > 0) throw fail("E_USAGE", `no proposed item ${unknown.join(", ")}; proposed: ${items.map((item) => item.id).join(", ") || "none"}`);
      const both = (ids ?? []).filter((id) => (strikes ?? []).includes(id));
      if (both.length > 0) throw fail("E_USAGE", `${both.join(", ")} named in both --ids and --strike`);
      before = snapshotActs(root, items);
      const snapshot = before;
      try {
        for (const id of strikes ?? []) {
          // Striking a principle, provision or update is the operator's ruling as much as adopting it.
          if (agent && OPERATOR_KINDS.some((prefix) => id.startsWith(prefix))) {
            acts.push({ id, act: "refused", refused: operatorOnly(id), code: "E_OPERATOR_ONLY" });
            continue;
          }
          strikeAny(root, /** @type {ProposedItem} */ (byId.get(id)), date);
          acts.push({ id, act: "struck" });
        }
        if (ids !== null) {
          for (const id of ids) {
            if (agent && OPERATOR_KINDS.some((prefix) => id.startsWith(prefix))) {
              acts.push({ id, act: "refused", refused: operatorOnly(id), code: "E_OPERATOR_ONLY" });
              continue;
            }
            const refused = adoptAny(root, /** @type {ProposedItem} */ (byId.get(id)), date);
            acts.push(refused === null ? { id, act: "adopted" } : { id, act: "refused", refused });
          }
        }
      } catch (error) {
        // An act that throws (a file that will not parse as adopted) leaves no half-done run behind.
        restoreSnapshot(root, snapshot);
        throw error;
      }
    }

    const refusals = acts.filter((act) => act.act === "refused");
    const { compiled, commit, message, rolledBack } = settleActs(root, items, acts, context.env, before);
    const ok = refusals.length === 0 && (compiled === null || compiled.errors.length === 0);
    const lines = [...shown];
    if (items.length === 0) lines.push("no proposed items");
    for (const act of acts) lines.push(act.code === undefined ? `${act.act} ${act.id}${act.refused ? `: ${act.refused}` : ""}` : `${act.code}: ${act.refused}`);
    if (compiled) {
      if (rolledBack) {
        const files = [...new Set(compiled.errors.map((finding) => finding.path).filter((path) => path !== undefined))];
        lines.push(
          `not adopted: the compile after it refused, so the adoption was undone and nothing was committed${files.length > 0 ? `; correct ${files.join(", ")} and adopt again` : ""}`,
        );
      } else {
        lines.push(compiled.errors.length === 0 ? "compiled .house/generated/" : "compile refused: projections not updated");
      }
      lines.push(...compiled.findings.map(findingLine));
    }
    if (commit !== null) lines.push(commitLine(commit, message));
    return {
      ok,
      exit: ok ? 0 : 1,
      data: {
        house: root,
        proposed: items.map((item) => ({ id: item.id, path: item.path, chars: item.chars, surface: item.surface, surfaceChars: item.surfaceChars, cap: item.cap, text: item.text })),
        acts,
        rolledBack,
        findings: compiled?.findings ?? [],
        commit: commit?.status === "committed" ? commit.sha : null,
        uncommitted: commit?.status === "uncommitted" ? { reason: commit.reason, command: commit.command } : null,
      },
      text: lines.join("\n"),
    };
  },
};

/** @type {import("../cli.js").Verb} */
export const proposeVerb = {
  name: "propose",
  summary: "file a draft as a proposal: principle, provision or reflex, with the occasion that calls for it",
  args: { min: 2, max: 2, usage: "principle|provision|reflex <file>" },
  more: proposeHelp,
  flags: {
    ...WORKSPACE_FLAGS,
    occasion: { type: "string", summary: "what happened that calls for this item (required)" },
  },
  run(context) {
    const [kind, file] = context.args;
    if (!KINDS.includes(/** @type {any} */ (kind))) throw fail("E_USAGE", `cannot propose a ${JSON.stringify(kind)}; propose a principle, provision or reflex`);
    const occasion = typeof context.flags.occasion === "string" ? context.flags.occasion.trim() : "";
    if (occasion === "") throw fail("E_USAGE", "lampstand propose needs --occasion \"<what happened that calls for it>\"");
    const root = houseRoot(context);
    const result = propose(root, /** @type {import("./parse.js").Kind} */ (kind), resolve(context.cwd, file), occasion, today());
    if ("refused" in result) return { ok: false, exit: 1, data: { house: root, refused: result.refused }, text: `not proposed: ${result.refused}` };
    const next = kind === "reflex" ? "the agent admits it with lampstand adopt under curation.md" : "it waits for the operator's lampstand adopt";
    return { data: { house: root, path: result.path }, text: `proposed ${result.path}; ${next}` };
  },
};

/** The constitution verbs, registered by core/bin/lampstand.js. @type {import("../cli.js").Verb[]} */
export const verbs = [compileVerb, adoptVerb, proposeVerb];
