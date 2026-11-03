#!/usr/bin/env node
// @ts-check
// Shipped text carries no em dash and no symbol marks: no character of Unicode category So or Sm above U+2000, except
// the box-drawing and block elements (U+2500-U+259F) the docs' text-art assets are drawn with. ASCII math (`<`, `=`)
// and the Latin-1 signs stay below the bound. One path is exempt by name and is only ever read, never rewritten:
// the lattice pack, shipped verbatim in its own words.
import { join } from "node:path";
import { lineIndex, parseArgs, readTextFile, report, runGate, shippedFiles } from "./gate-lib.js";

export const EXEMPT = "packs/lattice/LATTICE.md";
const EM_DASH = 0x2014;
const SYMBOL = /[\p{So}\p{Sm}]/u;

/** @param {number} cp */
function barred(cp) {
  if (cp === EM_DASH) return true;
  if (cp <= 0x2000 || (cp >= 0x2500 && cp <= 0x259f)) return false;
  return SYMBOL.test(String.fromCodePoint(cp));
}

/** @param {number} cp */
function label(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

runGate("prose-gate", "node dev/prose-gate.js [--root <dir>]", () => {
  const { root } = parseArgs(process.argv.slice(2));
  const findings = [];
  let scanned = 0;
  for (const path of shippedFiles(root)) {
    if (path === EXEMPT) continue;
    const text = readTextFile(join(root, path));
    if (text === null) continue;
    scanned++;
    const lineOf = lineIndex(text);
    for (let i = 0; i < text.length; i++) {
      const cp = /** @type {number} */ (text.codePointAt(i));
      if (cp > 0xffff) i++;
      if (barred(cp)) findings.push(`${path}:${lineOf(i)}:${label(cp)}`);
    }
  }
  return report("prose-gate", findings, `${scanned} shipped text files clean (${EXEMPT} exempt)`, `${findings.length} barred characters`);
});
