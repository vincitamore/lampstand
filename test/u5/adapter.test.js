// @ts-check
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { propose } from "../../core/lib/constitution/curate.js";
import { runCompile } from "../../core/lib/constitution/run.js";
import { renderRegion } from "../../core/lib/init/region.js";
import { plantHouse } from "../u2/helpers.js";
import { isolateProcessEnv, loadAdapter, session, stubHost, tempDir } from "./helpers.js";

const MARKER = {
  kernel: "<!-- lampstand:kernel -->",
  router: "<!-- lampstand:router:omp -->",
  worker: "<!-- lampstand:worker:omp -->",
};

/** @param {string} root @param {string} name */
function generated(root, name) {
  return readFileSync(join(root, ".house", "generated", name), "utf8");
}

/**
 * A compiled house in a temp dir, with process.env isolated.
 * @param {import("./helpers.js").TestContext} t
 * @param {string} [extra]  house.toml lines appended
 */
function compiledHouse(t, extra) {
  const dir = tempDir(t);
  isolateProcessEnv(t, dir);
  const root = join(dir, "house");
  plantHouse(root, { extra });
  const run = runCompile(root);
  assert.deepEqual(run.errors, []);
  return root;
}

/** @param {string} haystack @param {string} needle */
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("the factory registers exactly these events and the one command, and no tool interception", async () => {
  const host = await stubHost();
  assert.deepEqual(host.events(), ["before_agent_start", "session_start", "session_stop", "tool_execution_end"]);
  assert.deepEqual([...host.commands.keys()], ["lampstand"]);
  assert.deepEqual(host.sent, [], "the factory itself sends nothing");
});

test("below the version floor: one notice, and nothing else is registered", async (t) => {
  const { OMP_FLOOR } = await loadAdapter();
  for (const version of ["18.3.1", "17.9.9", undefined]) {
    const host = await stubHost({ version });
    assert.deepEqual(host.events(), ["session_start"], `version ${version}`);
    assert.deepEqual([...host.commands.keys()], [], `version ${version}`);
    const { ctx, notes } = session(tempDir(t));
    await host.emit("session_start", { type: "session_start" }, ctx);
    await host.emit("session_start", { type: "session_start" }, ctx);
    assert.equal(notes.length, 1, `version ${version}`);
    assert.equal(notes[0].level, "warning");
    assert.match(notes[0].text, new RegExp(`needs OMP ${OMP_FLOOR.replaceAll(".", "\\.")} or later`));
    assert.deepEqual(host.sent, []);
  }
  const atFloor = await stubHost({ version: OMP_FLOOR });
  assert.deepEqual(atFloor.events(), ["before_agent_start", "session_start", "session_stop", "tool_execution_end"]);
});

test("outside a house: dormant and silent, nothing injected", async (t) => {
  const dir = tempDir(t);
  isolateProcessEnv(t, dir);
  const host = await stubHost();
  const { ctx, notes } = session(dir);
  await host.emit("session_start", { type: "session_start" }, ctx);
  for (let i = 0; i < 3; i++) {
    assert.equal(await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] }, ctx), undefined);
  }
  await host.emit("tool_execution_end", { toolName: "write", isError: false, result: { details: { resolvedPath: join(dir, "a.txt") } } }, ctx);
  assert.equal(await host.emit("session_stop", { type: "session_stop" }, ctx), undefined);
  assert.deepEqual(notes, []);
  assert.deepEqual(host.sent, []);
});

test("the factory marks the agent's environment, and the operator's /lampstand adopt --ids still adopts a provision", async (t) => {
  const root = compiledHouse(t);
  delete process.env.LAMPSTAND_AGENT;
  const host = await stubHost();
  assert.equal(process.env.LAMPSTAND_AGENT, "omp");
  const draft = join(root, "..", "commit-as-it-lands.md");
  writeFileSync(draft, "# Commit as it lands\n\nCommit each piece of work when it is finished.\n");
  assert.ok("path" in propose(root, "provision", draft, "a batch commit lost work", "2026-11-03"));

  const { ctx } = session(root);
  await host.commands.get("lampstand")?.handler("adopt --ids provision/commit-as-it-lands", ctx);
  assert.match(host.sent.at(-1)?.message.content ?? "", /adopted provision\/commit-as-it-lands/);
  assert.equal(process.env.LAMPSTAND_AGENT, "omp", "the command does not strip the marker from the agent's own process");
});

test("main session: the orientation is queued once for the next turn, and the router is appended once", async (t) => {
  const root = compiledHouse(t);
  const host = await stubHost();
  const { ctx, notes } = session(root);
  await host.emit("session_start", { type: "session_start" }, ctx);
  assert.deepEqual(notes, []);
  assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0].message.customType, "lampstand-orientation");
  assert.equal(host.sent[0].options?.deliverAs, "nextTurn");

  const router = generated(root, "router.omp.md");
  const first = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] }, ctx);
  assert.deepEqual(first, { systemPrompt: ["base", router] });
  // The host re-prepares from the base on every prompt: the same addition comes back.
  assert.deepEqual(await host.emit("before_agent_start", { type: "before_agent_start", prompt: "again", systemPrompt: ["base"] }, ctx), first);
  // A prompt that already carries the marker (a chained or second copy of the extension) gets nothing more.
  assert.equal(await host.emit("before_agent_start", { type: "before_agent_start", prompt: "x", systemPrompt: first.systemPrompt }, ctx), undefined);
});

test("two loaded copies chained on one preparation add the router once", async (t) => {
  const root = compiledHouse(t);
  const a = await stubHost();
  const b = await stubHost();
  const { ctx } = session(root);
  let systemPrompt = ["base"];
  for (const host of [a, b]) {
    const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt }, ctx);
    if (result) systemPrompt = result.systemPrompt;
  }
  const joined = systemPrompt.join("\n");
  assert.equal(count(joined, MARKER.router), 1);
  assert.equal(systemPrompt.length, 2);
});

test("a prompt already carrying the kernel gets the router without a second copy of K", async (t) => {
  const root = compiledHouse(t);
  const host = await stubHost();
  const { ctx } = session(root);
  const kernel = generated(root, "kernel.md");
  const kernelLine = kernel.split("\n")[2];
  assert.ok(kernelLine.length > 0);
  const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base", kernel] }, ctx);
  const joined = result.systemPrompt.join("\n");
  assert.equal(count(joined, MARKER.kernel), 1);
  assert.equal(count(joined, MARKER.router), 1);
  assert.equal(count(joined, kernelLine), 1);
  assert.match(result.systemPrompt[2], /^## Principle detail$/m);
});

test("a prompt carrying the AGENTS.md region gets only the router sections the region left out", async (t) => {
  const root = compiledHouse(t);
  const host = await stubHost();
  const { ctx } = session(root);
  // OMP loads the house's AGENTS.md as a context file, so its region is already in the base prompt.
  const region = renderRegion(runCompile(root).compiled);
  assert.deepEqual([...region.matchAll(/^<!-- lampstand:section:([a-z]+) -->$/gm)].map((m) => m[1]), ["charter", "voice"]);
  const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base", region] }, ctx);
  const added = result.systemPrompt[2];
  assert.match(added, /^## Principle detail$/m, "the section too large for the region is appended");
  assert.doesNotMatch(added, /^## (Charter|Voice)$/m, "sections the region carries are not appended again");
  const joined = result.systemPrompt.join("\n");
  const voiceLine = "Collaboration manners and per-channel norms. The agent adds to this file only from what it has observed of the";
  assert.equal(count(joined, voiceLine), 1);
  assert.equal(count(joined, MARKER.router), 1);
});

test("subagent: W is appended and no router section; session-level handlers stay out", async (t) => {
  const root = compiledHouse(t);
  const host = await stubHost();
  const { ctx, notes } = session(root, "sub");
  await host.emit("session_start", { type: "session_start" }, ctx);
  assert.deepEqual(host.sent, []);
  const worker = generated(root, "worker.omp.md");
  const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "task", systemPrompt: ["base"] }, ctx);
  assert.deepEqual(result, { systemPrompt: ["base", worker] });
  const joined = result.systemPrompt.join("\n");
  assert.equal(count(joined, MARKER.worker), 1);
  assert.equal(count(joined, MARKER.router), 0);
  assert.doesNotMatch(joined, /^## (Principle detail|Charter|Voice)$/m);
  assert.equal(await host.emit("before_agent_start", { type: "before_agent_start", prompt: "more", systemPrompt: result.systemPrompt }, ctx), undefined);

  await host.emit("tool_execution_end", { toolName: "write", isError: false, result: { details: { resolvedPath: join(root, "x.txt") } } }, ctx);
  assert.equal(await host.emit("session_stop", { type: "session_stop" }, ctx), undefined);
  assert.deepEqual(notes, []);
  assert.deepEqual(host.sent, []);
});

test("a stale projection is still loaded, with one notice naming lampstand compile", async (t) => {
  const root = compiledHouse(t);
  writeFileSync(join(root, "voice.md"), `${readFileSync(join(root, "voice.md"), "utf8")}\n## email\n\nFull sentences.\n`);
  const host = await stubHost();
  const { ctx, notes } = session(root);
  await host.emit("session_start", { type: "session_start" }, ctx);
  const result = await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] }, ctx);
  assert.deepEqual(result, { systemPrompt: ["base", generated(root, "router.omp.md")] });
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /stale.*lampstand compile/);
});

test("a house never compiled: one notice naming lampstand compile, nothing injected, the orientation still queued", async (t) => {
  const dir = tempDir(t);
  isolateProcessEnv(t, dir);
  const root = join(dir, "house");
  plantHouse(root);
  const host = await stubHost();
  const { ctx, notes } = session(root);
  await host.emit("session_start", { type: "session_start" }, ctx);
  assert.deepEqual(host.sent.map((sent) => sent.message.customType), ["lampstand-orientation"]);
  assert.equal(await host.emit("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] }, ctx), undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /no compiled router:omp projection; run lampstand compile/);
});

test("remind mode: one reminder per session after edits, none without edits", async (t) => {
  const root = compiledHouse(t);
  const host = await stubHost();
  const { ctx } = session(root);
  await host.emit("session_start", { type: "session_start" }, ctx);
  host.sent.length = 0;
  assert.equal(await host.emit("session_stop", { type: "session_stop" }, ctx), undefined);
  assert.equal(host.sent.length, 0);

  await host.emit("tool_execution_end", { toolName: "edit", isError: false, result: { details: { path: "src/app.js" } } }, ctx);
  assert.equal(await host.emit("session_stop", { type: "session_stop" }, ctx), undefined);
  assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0].message.customType, "lampstand-gate");
  assert.equal(host.sent[0].options?.deliverAs, "nextTurn");
  assert.match(host.sent[0].message.content, /task: .*state: /);

  await host.emit("tool_execution_end", { toolName: "write", isError: false, result: { details: { resolvedPath: join(root, "b.txt") } } }, ctx);
  await host.emit("session_stop", { type: "session_stop" }, ctx);
  assert.equal(host.sent.length, 1, "at most once per session");
});

test("block mode: session_stop blocks until the owed records are written", async (t) => {
  const root = compiledHouse(t, '[gate]\nmode = "block"');
  const host = await stubHost();
  const { ctx } = session(root);
  await host.emit("session_start", { type: "session_start" }, ctx);
  await host.emit("tool_execution_end", { toolName: "write", isError: false, result: { details: { resolvedPath: join(root, "notes.txt") } } }, ctx);
  // A failed write changed nothing and owes nothing more.
  await host.emit("tool_execution_end", { toolName: "write", isError: true, result: { details: { resolvedPath: join(root, "principles", "x.md") } } }, ctx);
  const blocked = await host.emit("session_stop", { type: "session_stop" }, ctx);
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /task .*state /);
  assert.doesNotMatch(blocked.reason, /projections/);

  await host.emit("tool_execution_end", {
    toolName: "edit",
    isError: false,
    result: { details: { perFileResults: [{ path: join(root, "tasks", "t.md") }, { path: join(root, "state", "current.md") }] } },
  }, ctx);
  assert.equal(await host.emit("session_stop", { type: "session_stop" }, ctx), undefined);
});
