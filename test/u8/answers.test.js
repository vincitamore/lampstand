// @ts-check
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { askAnswers } from "../../core/lib/init/answers.js";

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
  const talk = script(["", "", "ana", "ben, cy", "For the clinic's families.", "maybe", "agreement", "Ask before pushing.", "", "## chat", "Short.", "", "n"]);
  const { dir, file } = await askAnswers(talk, options);
  assert.equal(dir, HOME);
  assert.deepEqual(file, {
    name: "ours",
    operator: "ana",
    co_owners: ["ben", "cy"],
    purpose: "For the clinic's families.",
    charter: "agreement",
    ask_first: ["Ask before pushing."],
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
  const talk = script(["", "named", "", "", "x".repeat(601), "short", "", "", ""]);
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
