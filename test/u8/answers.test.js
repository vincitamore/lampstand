// @ts-check
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { askAnswers, DEFAULT_ASK_FIRST } from "../../core/lib/init/answers.js";

/**
 * A scripted conversation: each ask takes the next reply and logs it after everything shown so far.
 * @param {string[]} replies
 */
function script(replies) {
  /** @type {string[]} */
  const log = [];
  return {
    log,
    /** @param {string} text */
    show(text) {
      log.push(`show ${text.trim()}`);
    },
    /** @param {string} question */
    async ask(question) {
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`no reply left for ${JSON.stringify(question)}`);
      log.push(`ask ${question.trim()}`);
      return reply;
    },
  };
}

const BASE = resolve("/", "tmp", "houses");
const HOME = join(BASE, "ours");
const options = { where: HOME, resolve: (/** @type {string} */ answer) => resolve(BASE, answer), planted: () => false, noLattice: false };

test("each of the six questions is explained before it is asked, and the answers are recorded as given", async () => {
  const talk = script(["", "", "ana", "ben, cy", "For the clinic's families.", "maybe", "agreement", "", "Ask before pushing.", "", "## chat", "Short.", "", "n"]);
  const { dir, file } = await askAnswers(talk, options);
  assert.equal(dir, HOME);
  assert.deepEqual(file, {
    name: "ours",
    operator: "ana",
    co_owners: ["ben", "cy"],
    purpose: "For the clinic's families.",
    charter: "agreement",
    ask_first: ["Ask before pushing."],
    ask_first_defaults: true,
    channel_manners: ["## chat", "Short."],
    lattice: false,
  });
  const numbered = talk.log.filter((line) => /^show [1-6]\. /.test(line)).map((line) => line.slice(5, 7));
  assert.deepEqual(numbered, ["1.", "2.", "3.", "4.", "5.", "6."]);
  for (const n of ["1.", "2.", "3.", "4.", "5.", "6."]) {
    const shown = talk.log.findIndex((line) => line.startsWith(`show ${n} `));
    assert.ok(talk.log[shown + 1].startsWith("ask "), `question ${n} is asked right after its explanation`);
  }
  assert.ok(talk.log.includes('show "maybe" is not one of none, rules, agreement.'), "an answer outside the modes is asked again");
});

test("an over-long purpose is asked again; --no-lattice asks nothing about the lattice", async () => {
  const talk = script(["", "named", "", "", "x".repeat(601), "short", "", "", "", ""]);
  const { file } = await askAnswers(talk, { ...options, noLattice: true });
  assert.equal(file?.purpose, "short");
  assert.equal(file?.charter, "rules");
  assert.equal(file?.lattice, undefined);
  assert.ok(talk.log.includes("show That is 601 characters; the limit is 600."));
  assert.ok(!talk.log.some((line) => line.includes("lattice")));
});

test("a folder that already holds a house ends the questions after the first", async () => {
  const talk = script(["standing"]);
  const result = await askAnswers(talk, { ...options, planted: (dir) => dir.endsWith("standing") });
  assert.deepEqual(result, { dir: join(BASE, "standing"), file: null });
});

test("question 6 shows the default ask-first lines first; Keep? takes yes by default, no declines them, and the operator's lines are added after", async () => {
  const keep = script(["", "", "", "", "For the clinic.", "", "", "", "", "", "n"]);
  const kept = await askAnswers(keep, options);
  assert.equal(kept.file?.ask_first_defaults, true);
  const six = keep.log.findIndex((line) => line.startsWith("show 6. "));
  for (const line of DEFAULT_ASK_FIRST) assert.ok(keep.log[six].includes(`- ${line}`), line);
  assert.equal(keep.log[six + 1], "ask Keep these? [Y/n]:", "the defaults are shown, then asked about");

  for (const no of ["n", "No"]) {
    const declined = script(["", "", "", "", "For the clinic.", "", no, "Ask before pushing.", "Ask before emailing.", "", "", "n"]);
    const { file } = await askAnswers(declined, options);
    assert.equal(file?.ask_first_defaults, false);
    assert.deepEqual(file?.ask_first, ["Ask before pushing.", "Ask before emailing."]);
  }
});

test("the default lines count toward the kernel: a purpose too long beside them is asked again", async () => {
  const talk = script(["", "", "", "", "x".repeat(450), "", "", "", "", "", "short"]);
  const { file } = await askAnswers(talk, options);
  assert.equal(file?.purpose, "short");
  assert.ok(talk.log.some((line) => /^show The kernel would be \d+ characters, \d+ over its cap of 4000/.test(line)));
});
