// @ts-check
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STATE_SCHEMA_VERSION, openStateDb } from "../../core/lib/state/db.js";
import { tempDir } from "./helpers.js";

const WRITER = fileURLToPath(new URL("./fixtures/writer.js", import.meta.url));
const ROWS = 1000;
const NODE = process.versions.bun ? "node" : process.execPath;
const BUN = process.versions.bun ? process.execPath : "bun";

/** @param {string} bin */
function available(bin) {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function run(bin, args) {
  return new Promise((done, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

test("a Node writer and a Bun writer insert 1,000 rows each into one house.db at once", async (t) => {
  const missing = [NODE, BUN].filter((bin) => !available(bin));
  if (missing.length > 0) {
    t.skip(`not on PATH: ${missing.join(", ")}`);
    return;
  }
  const dir = tempDir(t);
  const stateDir = join(dir, "state");
  const barrier = join(dir, "barrier");
  mkdirSync(barrier);
  const writers = [run(NODE, [WRITER, stateDir, barrier, "node", String(ROWS)]), run(BUN, [WRITER, stateDir, barrier, "bun", String(ROWS)])];
  const deadline = Date.now() + 30000;
  while (!(existsSync(join(barrier, "ready-node")) && existsSync(join(barrier, "ready-bun")))) {
    assert.ok(Date.now() < deadline, "writers did not start");
    await new Promise((done) => setTimeout(done, 10));
  }
  writeFileSync(join(barrier, "go"), "");
  const results = await Promise.all(writers);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const [node, bun] = results.map((result) => JSON.parse(result.stdout));
  assert.deepEqual([node.driver, bun.driver], ["node:sqlite", "bun:sqlite"]);
  // The insert loops ran at the same time, so the busy timeout, not luck, kept every row.
  assert.ok(node.start < bun.end && bun.start < node.end, `write windows did not overlap: ${JSON.stringify({ node, bun })}`);

  const { db } = openStateDb(stateDir);
  try {
    const counts = Object.fromEntries(
      db.prepare("SELECT source, count(*) AS n FROM events GROUP BY source").all().map((row) => [row.source, row.n]),
    );
    assert.deepEqual(counts, { bun: ROWS, node: ROWS });
    assert.equal(db.get("SELECT count(*) AS n FROM events")?.n, 2 * ROWS);
    assert.equal(db.get("SELECT value FROM meta WHERE key = 'schema_version'")?.value, String(STATE_SCHEMA_VERSION));
    const order = db.prepare("SELECT source FROM events ORDER BY id").all().map((row) => row.source);
    const switches = order.filter((source, k) => k > 0 && source !== order[k - 1]).length;
    t.diagnostic(`node ${Math.round(node.end - node.start)} ms, bun ${Math.round(bun.end - bun.start)} ms, overlap ${Math.round(Math.min(node.end, bun.end) - Math.max(node.start, bun.start))} ms, writer switches in id order: ${switches}`);
  } finally {
    db.close();
  }
});
