// @ts-check
// Usage: <runtime> writer.js <state dir> <barrier dir> <label> <rows>
// Announces itself in the barrier dir, waits for the go file, then opens house.db (racing the other writer through
// creation and migration) and inserts one row per autocommit statement.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStateDb } from "../../../core/lib/state/db.js";
import { DRIVER } from "../../../core/lib/state/sqlite.js";

const [stateDir, barrier, label, rows] = process.argv.slice(2);
writeFileSync(join(barrier, `ready-${label}`), DRIVER);
const deadline = Date.now() + 30000;
while (!existsSync(join(barrier, "go"))) {
  if (Date.now() > deadline) throw new Error("no go signal");
  await new Promise((done) => setTimeout(done, 5));
}

const { db } = openStateDb(stateDir);
// Opening races through creation and migration, which one writer can finish well before the other; a second barrier
// after the open makes the two insert loops start together, so the overlap the test asserts is arranged, not hoped for.
writeFileSync(join(barrier, `opened-${label}`), "");
while (readdirSync(barrier).filter((name) => name.startsWith("opened-")).length < 2) {
  if (Date.now() > deadline) throw new Error("the other writer never opened house.db");
  await new Promise((done) => setTimeout(done, 1));
}
const insert = db.prepare("INSERT INTO events (at, kind, source, payload) VALUES (?, 'probe', ?, ?)");
const start = performance.timeOrigin + performance.now();
for (let n = 0; n < Number(rows); n++) insert.run(new Date().toISOString(), label, JSON.stringify({ n }));
const end = performance.timeOrigin + performance.now();
db.close();
process.stdout.write(`${JSON.stringify({ label, driver: DRIVER, rows: Number(rows), start, end })}\n`);
