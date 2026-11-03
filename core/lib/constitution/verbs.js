// @ts-check
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { commitLine, commitOnly } from "../commit.js";
import { fail } from "../errors.js";
import { isAgentShell } from "../operator.js";
import { WORKSPACE_FLAGS, resolveHouse } from "../root.js";
import { actPaths, adoptItem, listProposals, propose, sizeLine, strikeItem, today } from "./curate.js";
import { proposeHelp } from "./examples.js";
import { KINDS } from "./parse.js";
import { runCompile } from "./run.js";

/** @typedef {import("../cli.js").VerbContext} VerbContext */
/** @typedef {import("../cli.js").VerbResult} VerbResult */
/** @typedef {import("./curate.js").ProposedItem} ProposedItem */
/** @typedef {import("./rules.js").Finding} Finding */

/** Kinds only the operator adopts; reflexes are the one kind an agent may admit. */
const OPERATOR_KINDS = ["principle/", "provision/"];

/** @param {string} id */
function operatorOnly(id) {
  return `${id} waits for the operator: principles and provisions are adopted by the operator, in a terminal or with /lampstand adopt`;
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
  for (const id of listProposals(root).map((item) => item.id)) {
    for (;;) {
      const item = listProposals(root).find((candidate) => candidate.id === id);
      if (!item) break;
      talk.show(`\n=== ${item.id} (${item.path})\n${item.text}${item.text.endsWith("\n") ? "" : "\n"}--- ${sizeLine(item)}`);
      const answer = (await talk.ask("adopt, edit, strike or later? [later] ")).trim().toLowerCase();
      if (answer === "" || answer === "l" || answer === "later") {
        acts.push({ id, act: "later" });
        break;
      }
      if (answer === "a" || answer === "adopt") {
        const refused = adoptItem(root, item, date);
        acts.push(refused === null ? { id, act: "adopted" } : { id, act: "refused", refused });
        if (refused !== null) talk.show(`not adopted: ${refused}`);
        break;
      }
      if (answer === "s" || answer === "strike") {
        strikeItem(root, item, date);
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
 * refused.
 * @param {string} root
 * @param {ProposedItem[]} items  the proposals as they stood before the run
 * @param {{ id: string, act: string }[]} acts
 * @param {NodeJS.ProcessEnv} env
 */
export function settleActs(root, items, acts, env) {
  const adopted = acts.filter((act) => act.act === "adopted");
  const struck = acts.filter((act) => act.act === "struck");
  // Proposals and the record are not compiler inputs, so only an adoption makes the projections stale.
  const compiled = adopted.length > 0 ? runCompile(root) : null;
  const byId = new Map(items.map((item) => [item.id, item]));
  /** @type {string[]} */
  const paths = [];
  for (const [list, act] of /** @type {const} */ ([[adopted, "adopted"], [struck, "struck"]])) {
    for (const { id } of list) paths.push(...actPaths(/** @type {ProposedItem} */ (byId.get(id)), act));
  }
  paths.push(...(compiled?.written ?? []));
  const message = [adopted.length > 0 ? `Adopt ${adopted.map((act) => act.id).join(", ")}` : "", struck.length > 0 ? `Strike ${struck.map((act) => act.id).join(", ")}` : ""]
    .filter((part) => part !== "")
    .join("; ");
  const commit = paths.length === 0 ? null : commitOnly(root, paths, message, env);
  return { compiled, commit, message };
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
  summary: "show every proposed item verbatim with its size; adopt, edit, strike or leave it for later (default later); what is adopted or struck is committed",
  flags: {
    ...WORKSPACE_FLAGS,
    ids: { type: "string", summary: "adopt exactly these items, comma-separated <kind>/<slug>, without asking" },
  },
  async run(context) {
    const root = houseRoot(context);
    const date = today();
    const items = listProposals(root);
    /** @type {{ id: string, act: string, refused?: string, code?: string }[]} */
    let acts = [];
    const shown = [];
    const ids = typeof context.flags.ids === "string" ? context.flags.ids.split(",").map((id) => id.trim()).filter((id) => id !== "") : null;
    // An agent's shell never gets the interactive loop: answering it would be the agent adopting for the operator.
    const agent = isAgentShell(context.env);
    const interactive = ids === null && !agent && !context.json && process.stdin.isTTY === true && process.stdout.isTTY === true;

    if (interactive) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        acts = await adoptInteractively(root, terminalConversation(context.env, rl), date);
      } finally {
        rl.close();
      }
    } else {
      for (const item of items) shown.push(`=== ${item.id} (${item.path})\n${item.text}${item.text.endsWith("\n") ? "" : "\n"}--- ${sizeLine(item)}`);
      if (ids !== null) {
        const byId = new Map(items.map((item) => [item.id, item]));
        const unknown = ids.filter((id) => !byId.has(id));
        if (unknown.length > 0) throw fail("E_USAGE", `no proposed item ${unknown.join(", ")}; proposed: ${items.map((item) => item.id).join(", ") || "none"}`);
        for (const id of ids) {
          if (agent && OPERATOR_KINDS.some((prefix) => id.startsWith(prefix))) {
            acts.push({ id, act: "refused", refused: operatorOnly(id), code: "E_OPERATOR_ONLY" });
            continue;
          }
          const refused = adoptItem(root, /** @type {ProposedItem} */ (byId.get(id)), date);
          acts.push(refused === null ? { id, act: "adopted" } : { id, act: "refused", refused });
        }
      }
    }

    const refusals = acts.filter((act) => act.act === "refused");
    const { compiled, commit, message } = settleActs(root, items, acts, context.env);
    const ok = refusals.length === 0 && (compiled === null || compiled.errors.length === 0);
    const lines = [...shown];
    if (items.length === 0) lines.push("no proposed items");
    for (const act of acts) lines.push(act.code === undefined ? `${act.act} ${act.id}${act.refused ? `: ${act.refused}` : ""}` : `${act.code}: ${act.refused}`);
    if (compiled) {
      lines.push(compiled.errors.length === 0 ? "compiled .house/generated/" : "compile refused: projections not updated");
      lines.push(...compiled.findings.map(findingLine));
    }
    if (commit !== null) lines.push(commitLine(commit, message));
    return {
      ok,
      exit: ok ? 0 : 1,
      data: {
        house: root,
        proposed: items.map((item) => ({ id: item.id, path: item.path, chars: item.chars, surface: item.surface, surfaceChars: item.surfaceChars, cap: item.cap })),
        acts,
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
