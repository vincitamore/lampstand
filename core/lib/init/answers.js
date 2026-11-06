// @ts-check
// The six Plant questions: where the house lives, its name, who has care of it, its purpose, how rules are made,
// and the ask-first lines with the channel manners; then the one question about the lattice. On a terminal each
// is explained before it is asked; `--answers <file>` gives the same answers as TOML. The operator's words are
// recorded as given: nothing is suggested, drafted or filled in on their behalf beyond the stated defaults.
//
//   where = "."                     # the house's folder, relative to the current directory
//   name = "my-house"               # default: the folder's name
//   operator = "ana"
//   co_owners = []
//   purpose = "who the work is for"  # at most 600 characters
//   charter = "rules"               # none | rules | agreement (default rules)
//   ask_first = ["..."]             # your own lines, added after the defaults below
//   ask_first_defaults = true       # plant DEFAULT_ASK_FIRST first (default true); false plants only ask_first
//   channel_manners = ["## chat", "Short replies."]   # lines, or one string
//   lattice = true                  # plant the lattice (default) or start with no principles
import { basename } from "node:path";
import { BUDGETS, KERNEL_FRAMING_CHARS, chars } from "../constitution/budgets.js";
import { renderKernel } from "../constitution/compile.js";
import { parsePrincipleText } from "../constitution/parse.js";
import { fail } from "../errors.js";
import { readText } from "../io.js";
import { validate } from "../config.js";
import { parseToml } from "../parse/toml.js";
import { LATTICE_FILE, latticeFile } from "./plant.js";

/** @typedef {import("../config.js").Schema} Schema */
/** @typedef {import("./plant.js").Answers} Answers */
/** @typedef {{ show(text: string): void, ask(question: string): Promise<string> }} Conversation */

export const PURPOSE_MAX = 600;

/**
 * The ask-first lines a house starts with unless its operator declines them: the actions an agent must ask about
 * whatever else the house is for. They ride in the kernel of every session, so the list stays short.
 */
export const DEFAULT_ASK_FIRST = Object.freeze([
  "Irreversible deletes",
  "Rewriting git history",
  "Publishing or pushing to a remote",
  "Spending money",
  "Messaging people outside the house",
  "Sending secrets or private data away",
  "Changing live systems",
]);

/**
 * The kernel these answers compile to, measured as the compiler measures it (with Hermes's section framing), against
 * the cap of the profile init will set. The purpose, one line per principle and the ask-first lines all go into the
 * kernel, so a purpose within PURPOSE_MAX can still overflow it beside the lattice and a long ask-first list.
 * @param {Pick<Answers, "purpose" | "askFirst" | "lattice">} answers
 * @returns {{ chars: number, cap: number, over: number }}
 */
export function kernelFit(answers) {
  const planted = latticeFile("2000-01-01");
  const principleFiles = answers.lattice ? [parsePrincipleText(planted.text, LATTICE_FILE)] : [];
  const house = /** @type {import("../constitution/house.js").House} */ (
    /** @type {unknown} */ ({ purpose: { text: answers.purpose }, principleFiles, askFirst: answers.askFirst })
  );
  const size = KERNEL_FRAMING_CHARS + chars(renderKernel(house));
  const cap = BUDGETS[answers.lattice ? "large" : "standard"].kernel;
  return { chars: size, cap, over: Math.max(0, size - cap) };
}

/** One sentence naming a kernel overflow and what to shorten. @param {{ chars: number, cap: number, over: number }} fit */
export function kernelFitText(fit) {
  return `the kernel would be ${fit.chars} characters, ${fit.over} over its cap of ${fit.cap}: the purpose, one line per principle and the ask-first lines all go into it, so shorten the purpose or the ask-first lines by ${fit.over} characters`;
}

export const CHARTER_MODES = /** @type {const} */ (["none", "rules", "agreement"]);

/** @type {Schema} */
export const ANSWERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    where: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    operator: { type: "string" },
    co_owners: { type: "array", items: { type: "string", minLength: 1 } },
    purpose: { type: "string", maxLength: PURPOSE_MAX },
    charter: { type: "string", enum: [...CHARTER_MODES] },
    ask_first: { type: "array", items: { type: "string", minLength: 1, pattern: "^[^\\n]*\\S[^\\n]*$" } },
    ask_first_defaults: { type: "boolean" },
    channel_manners: {},
    lattice: { type: "boolean" },
  },
};

/**
 * @typedef {{
 *   where?: string,
 *   name?: string,
 *   operator?: string,
 *   co_owners?: string[],
 *   purpose?: string,
 *   charter?: Answers["charter"],
 *   ask_first?: string[],
 *   ask_first_defaults?: boolean,
 *   channel_manners?: string | string[],
 *   lattice?: boolean,
 * }} AnswersFile
 */

/**
 * Reads and validates an answers file.
 * @param {string} path
 * @returns {AnswersFile}
 */
export function readAnswersFile(path) {
  const lines = new Map();
  const data = parseToml(readText(path), path, { lines });
  validate(ANSWERS_SCHEMA, data, path, lines);
  const manners = data.channel_manners;
  if (manners !== undefined && typeof manners !== "string" && !(Array.isArray(manners) && manners.every((line) => typeof line === "string"))) {
    throw fail("E_SCHEMA", "channel_manners must be a string or an array of strings (one per line)", {
      path,
      line: lines.get(JSON.stringify(["channel_manners"])),
    });
  }
  return /** @type {AnswersFile} */ (data);
}

/**
 * The ask-first lines an answers file gives: the defaults unless declined, then its own lines, each once.
 * @param {AnswersFile} file
 */
function askFirstFrom(file) {
  const own = (file.ask_first ?? []).map((line) => line.trim());
  return [...new Set([...(file.ask_first_defaults === false ? [] : DEFAULT_ASK_FIRST), ...own])];
}

/**
 * The answers for a house in `dir`, from a file's values and the defaults.
 * @param {AnswersFile} file
 * @param {string} dir  the house's folder, absolute
 * @param {{ noLattice: boolean }} options
 * @returns {Answers}
 */
export function answersFrom(file, dir, options) {
  const manners = file.channel_manners;
  return {
    name: file.name ?? basename(dir),
    operator: (file.operator ?? "").trim(),
    coOwners: (file.co_owners ?? []).map((owner) => owner.trim()),
    purpose: (file.purpose ?? "").trim(),
    charter: file.charter ?? "rules",
    askFirst: askFirstFrom(file),
    channelManners: (Array.isArray(manners) ? manners.join("\n") : (manners ?? "")).trim(),
    lattice: !options.noLattice && (file.lattice ?? true),
  };
}

/**
 * Reads lines until an empty one.
 * @param {Conversation} talk
 * @param {string} prompt
 */
async function askLines(talk, prompt) {
  /** @type {string[]} */
  const lines = [];
  for (;;) {
    const line = (await talk.ask(prompt)).trimEnd();
    if (line.trim() === "") return lines;
    lines.push(line);
  }
}

/**
 * Asks the questions on a terminal. `planted(dir)` says whether a house already stands in `dir`: then nothing more
 * is asked, since its house.toml already holds every answer and init only fills in missing files.
 * @param {Conversation} talk
 * @param {{ where: string, resolve: (answer: string) => string, planted: (dir: string) => boolean, noLattice: boolean }} options
 * @returns {Promise<{ dir: string, file: AnswersFile | null }>}
 */
export async function askAnswers(talk, options) {
  talk.show(
    "1. Where. A house is a folder, and a git repository you own, holding the principles and rules your agent works under, its tasks, decisions and knowledge as plain files. lampstand plants only files that are missing and never overwrites one.",
  );
  const dir = options.resolve((await talk.ask(`Folder [${options.where}]: `)).trim() || options.where);
  if (options.planted(dir)) {
    talk.show(`A house already stands in ${dir}; its house.toml holds the answers, so only missing files are planted.`);
    return { dir, file: null };
  }

  talk.show("\n2. Name. What the house is called in lampstand's output and in per-user config.");
  const name = (await talk.ask(`Name [${basename(dir)}]: `)).trim() || basename(dir);

  talk.show(
    "\n3. Care. Who has care of this house: the operator, whose word decides, and any co-owners who share that care. The agent works for them and asks them first.",
  );
  const operator = (await talk.ask("Operator: ")).trim();
  const coOwners = (await talk.ask("Co-owners, separated by commas (empty for none): "))
    .split(",")
    .map((owner) => owner.trim())
    .filter((owner) => owner !== "");

  talk.show(
    `\n4. Purpose. Who the work is for, in your own words, at most ${PURPOSE_MAX} characters. It opens the kernel every session loads, so it is read before anything else.`,
  );
  let purpose = (await talk.ask("Purpose: ")).trim();
  while ([...purpose].length > PURPOSE_MAX) {
    talk.show(`That is ${[...purpose].length} characters; the limit is ${PURPOSE_MAX}.`);
    purpose = (await talk.ask("Purpose: ")).trim();
  }

  talk.show(
    "\n5. How rules work. none: no charter, no provisions are enacted. rules: you enact provisions; the agent may only draft them as proposals. agreement: a provision is enacted when you and the co-owners agree to it.",
  );
  /** @type {string} */
  let charter = (await talk.ask("none, rules or agreement [rules]: ")).trim() || "rules";
  while (!(/** @type {readonly string[]} */ (CHARTER_MODES).includes(charter))) {
    talk.show(`${JSON.stringify(charter)} is not one of none, rules, agreement.`);
    charter = (await talk.ask("none, rules or agreement [rules]: ")).trim() || "rules";
  }

  talk.show(
    `\n6. Ask-first lines and channel manners. Ask-first lines are what the agent must ask you about before doing; every session carries them. These come first:\n${DEFAULT_ASK_FIRST.map((line) => `  - ${line}`).join("\n")}`,
  );
  const keep = (await talk.ask("Keep these? [Y/n]: ")).trim().toLowerCase();
  const defaults = !(keep === "n" || keep === "no");
  talk.show("Your own ask-first lines are added after them, one per line. An empty line ends the list.");
  const askFirst = (await askLines(talk, "Ask first: ")).map((line) => line.trim());
  talk.show(
    "Channel manners: how the agent should carry itself with you, and in each channel you use (a `## <channel>` line starts a channel's norms). They go into voice.md. An empty line ends them.",
  );
  const channelManners = await askLines(talk, "> ");

  /** @type {AnswersFile} */
  const file = { name, operator, co_owners: coOwners, purpose, charter: /** @type {Answers["charter"]} */ (charter), ask_first: askFirst, ask_first_defaults: defaults, channel_manners: channelManners };
  if (!options.noLattice) {
    talk.show(
      "\nPrinciples. The lattice is a pack of thirteen principles for judging work, drawn from classical and Christian philosophy and from engineering practice: inversion, single source, structural correctness over passing the test, logical coherence, primitives over opinions and others, each with the failure it guards against. Every session in the house carries one line of each. lampstand can copy it into principles/lattice.md as your own adopted copy, yours from then on to edit or strike; it needs the large budget profile, which init then sets. Or start with no principles and adopt your own later.",
    );
    const reply = (await talk.ask("Plant the lattice? [Y/n]: ")).trim().toLowerCase();
    file.lattice = !(reply === "n" || reply === "no");
  }
  // The purpose, the principles and the ask-first lines share the kernel's cap, so the purpose is asked again until
  // the three fit; nothing is planted before they do.
  for (let fit = kernelFit(answersFrom(file, dir, options)); fit.over > 0; fit = kernelFit(answersFrom(file, dir, options))) {
    talk.show(`\nThe ${kernelFitText(fit).replace(/^the /, "")}. Your purpose is ${[...(file.purpose ?? "")].length} characters.`);
    file.purpose = (await talk.ask("Purpose: ")).trim();
  }
  return { dir, file };
}
