#!/usr/bin/env node
// @ts-check
// Plants the largest house a first run can make (the lattice planted, the longest purpose init accepts beside it) in a temp
// directory with the tree's own CLI, compiles it, and prints every surface's size. It fails when the kernel is over
// its hard cap, when the compiler refuses to write the projections, or when the house's AGENTS.md, the one file of a
// house Hermes loads as a context file, is over Hermes's context-file floor: past it Hermes keeps only a head and a
// tail, cutting the router region it carries.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BUDGETS, chars, KERNEL_FRAMING_CHARS } from "../core/lib/constitution/budgets.js";
import { findRegion } from "../core/lib/init/region.js";
import { GateError, parseArgs, report, runGate } from "./gate-lib.js";

/** The floor of Hermes's per-file context cap; the same value as hosts/hermes/context.py CONTEXT_FILE_MAX_CHARS. */
export const HERMES_CONTEXT_FILE_FLOOR = 20_000;

/** @typedef {{ chars: number, cap: number, over: number }} Fit */

/**
 * The longest purpose the tree's init accepts beside its lattice and the ask-first lines `askFirst` (the defaults init plants): at most `max` characters,
 * and short enough that the kernel fits its cap (init refuses answers whose kernel would not), measured by the tree's
 * own `kernelFit`. It ends on a non-space, so the answer's trim keeps every character. With an empty purpose still
 * over the cap, `fit` says by how much.
 * @param {(answers: { purpose: string, askFirst: string[], lattice: boolean }) => Fit} kernelFit
 * @param {number} max
 * @param {readonly string[]} [askFirst]
 * @returns {{ purpose: string, fit: Fit }}
 */
export function longPurpose(kernelFit, max, askFirst = []) {
  const sentence = "The work is for the people who rely on what this house keeps and decides, and for the ones who come after. ";
  const text = (/** @type {number} */ n) => {
    const cut = sentence.repeat(Math.ceil(n / sentence.length) + 1).slice(0, n);
    return cut.endsWith(" ") ? `${cut.slice(0, -1)}.` : cut;
  };
  const fitOf = (/** @type {number} */ n) => kernelFit({ purpose: text(n), askFirst: [...askFirst], lattice: true });
  let n = max;
  while (n > 0 && fitOf(n).over > 0) n -= 1;
  return { purpose: text(n), fit: fitOf(n) };
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
function lampstand(bin, args, cwd, env) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8", windowsHide: true, timeout: 50_000 });
  if (result.error) throw new GateError(`lampstand ${args[0]}: ${result.error.message}`);
  const line = result.stdout.trim().split("\n").pop() ?? "";
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    throw new GateError(`lampstand ${args[0]} exited ${result.status} without a JSON answer: ${result.stderr.trim() || line}`);
  }
  return { status: result.status, data };
}

/** @param {string} name @param {number} size @param {string} [limit] */
function row(name, size, limit = "") {
  return `  ${name.padEnd(28)} ${String(size).padStart(6)} chars${limit === "" ? "" : `  (${limit})`}`;
}

runGate("context-budget", "node dev/context-budget.js [--root <lampstand tree>]", async () => {
  const { root } = parseArgs(process.argv.slice(2));
  const bin = join(root, "core", "bin", "lampstand.js");
  if (!existsSync(bin)) throw new GateError(`${bin} does not exist`);
  // The tree's own answers module, so the purpose is measured against that tree's lattice and caps.
  const { kernelFit, PURPOSE_MAX, DEFAULT_ASK_FIRST } = await import(pathToFileURL(join(root, "core", "lib", "init", "answers.js")).href);
  const { purpose, fit } = longPurpose(kernelFit, PURPOSE_MAX, DEFAULT_ASK_FIRST);
  if (fit.over > 0) {
    const finding = `context-budget: kernel is ${fit.chars} chars with an empty purpose and the default ask-first lines (with ${KERNEL_FRAMING_CHARS} of Hermes section framing), over its hard cap of ${fit.cap}; init refuses every answer`;
    return report("context-budget", [finding], "", "1 budget failures");
  }
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lampstand-context-budget-")));
  try {
    const house = join(temp, "house");
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, LAMPSTAND_STATE_ROOT: join(temp, "state-root"), LAMPSTAND_CONFIG_ROOT: join(temp, "config-root") };
    delete env.HOUSE_ROOT;
    const answers = join(temp, "answers.toml");
    writeFileSync(answers, `name = "budget-probe"\noperator = "operator"\npurpose = ${JSON.stringify(purpose)}\ncharter = "rules"\nlattice = true\n`);

    const init = lampstand(bin, ["init", house, "--answers", answers, "--json"], temp, env);
    if (!existsSync(join(house, "house.toml"))) throw new GateError(`lampstand init planted no house (exit ${init.status})`);
    const compiled = lampstand(bin, ["compile", "--json"], house, env);
    const data = compiled.data;

    /** @type {string[]} */
    const findings = [];
    const lines = [`context-budget: house planted with the lattice, the default ask-first lines and a ${chars(purpose)}-character purpose; profile ${data.profile}`];
    lines.push("surfaces (as the compiler measures them):");
    /** @type {Record<string, { chars: number, cap: number, tokens: number }>} */
    const surfaces = data.surfaces ?? {};
    for (const [key, size] of Object.entries(surfaces)) lines.push(row(key, size.chars, `cap ${size.cap}, ~${size.tokens} tokens`));

    const kernelCap = BUDGETS[/** @type {keyof typeof BUDGETS} */ (data.profile)]?.kernel ?? BUDGETS.standard.kernel;
    const kernel = surfaces.kernel;
    if (kernel === undefined) findings.push("context-budget: the compiler reported no kernel size");
    else if (kernel.chars > kernelCap) {
      findings.push(`context-budget: kernel is ${kernel.chars} chars (with ${KERNEL_FRAMING_CHARS} of Hermes section framing), over its hard cap of ${kernelCap}`);
    }
    for (const finding of data.findings ?? []) lines.push(`  compile ${finding.level}: ${finding.message}`);
    if (data.ok !== true) findings.push(`context-budget: lampstand compile refused to write the projections (exit ${compiled.status})`);

    const generated = join(house, ".house", "generated");
    lines.push("projections (files written):");
    const written = existsSync(generated) ? readdirSync(generated).filter((name) => name.endsWith(".md")).sort() : [];
    if (written.length === 0) lines.push("  none");
    for (const name of written) lines.push(row(name, chars(readFileSync(join(generated, name), "utf8"))));

    lines.push("loads through AGENTS.md (Hermes context file):");
    const agents = readFileSync(join(house, "AGENTS.md"), "utf8").replaceAll("\r\n", "\n");
    const region = findRegion(agents);
    if (region !== null) lines.push(row("AGENTS.md region", chars(agents.slice(region.from, region.to))));
    const loaded = chars(agents.trim());
    lines.push(row("AGENTS.md", loaded, `floor ${HERMES_CONTEXT_FILE_FLOOR}`));
    if (loaded > HERMES_CONTEXT_FILE_FLOOR) {
      findings.push(`context-budget: AGENTS.md is ${loaded} chars, over the Hermes context-file floor of ${HERMES_CONTEXT_FILE_FLOOR}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return report("context-budget", findings, "kernel within its cap and AGENTS.md within the Hermes floor", `${findings.length} budget failures`);
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
