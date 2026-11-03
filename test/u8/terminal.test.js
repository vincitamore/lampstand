// @ts-check
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { terminal } from "../../core/lib/init/verbs.js";

test("answers that arrive all at once leave each prompt on its own line, so the next explanation starts a fresh one", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => (written += chunk));
  input.write("first\n\nsecond\n");
  const talk = terminal(input, output);
  assert.equal(await talk.ask("Ask first: "), "first");
  assert.equal(await talk.ask("Ask first: "), "");
  talk.show("Channel manners: how the agent should carry itself.");
  assert.equal(await talk.ask("> "), "second");
  talk.close();
  assert.equal(written, "Ask first: \nAsk first: \nChannel manners: how the agent should carry itself.\n> \n");
});
