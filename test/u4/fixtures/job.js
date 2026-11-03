// @ts-check
// A scripted job. Each argument is one step, run in order:
//   write:<rel>=<text>    stage a file under HOUSE_RUN_OUT
//   live:<rel>=<text>     write straight into the house, as a person editing during the run would
//   bulk:<n>:<dir>        stage n files under <dir>, 1,000 per subdirectory
//   env:<NAME>            stage env/<NAME>.txt holding the variable's value, or <unset>
//   touch:<abs>           create a marker file at an absolute path
//   wait:<abs>            wait (up to 30 s) until that file exists
//   sleep:<ms>
//   exit:<code>
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const out = /** @type {string} */ (process.env.HOUSE_RUN_OUT);
const root = /** @type {string} */ (process.env.HOUSE_ROOT);

/** @param {string} base @param {string} rel @param {string} text */
function put(base, rel, text) {
  const path = join(base, ...rel.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** @param {number} ms */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (const step of process.argv.slice(2)) {
  const colon = step.indexOf(":");
  const verb = step.slice(0, colon);
  const rest = step.slice(colon + 1);
  if (verb === "write" || verb === "live") {
    const eq = rest.indexOf("=");
    put(verb === "write" ? out : root, rest.slice(0, eq), rest.slice(eq + 1));
  } else if (verb === "bulk") {
    const [count, dir] = rest.split(":");
    for (let k = 0; k < Number(count); k++) {
      const sub = join(out, dir, `d${String(Math.floor(k / 1000)).padStart(2, "0")}`);
      if (k % 1000 === 0) mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `f${String(k).padStart(5, "0")}.txt`), `${k}\n`);
    }
  } else if (verb === "env") {
    put(out, `env/${rest}.txt`, process.env[rest] ?? "<unset>");
  } else if (verb === "touch") {
    writeFileSync(rest, "");
  } else if (verb === "wait") {
    const deadline = Date.now() + 30_000;
    while (!existsSync(rest) && Date.now() < deadline) sleep(20);
  } else if (verb === "sleep") {
    sleep(Number(rest));
  } else if (verb === "exit") {
    process.exit(Number(rest));
  } else {
    throw new Error(`unknown step ${step}`);
  }
}
