#!/usr/bin/env node
// @ts-check
// Draws docs/assets/lampstand-lockup.txt as SVG for the README: a code block on GitHub sets block characters at a
// line height above 1, which opens a gap between rows, while the mark is drawn with rows touching. Each character
// cell is 1 unit wide and 2 tall; a full block fills it, an upper or lower half block fills half of it. Runs of the
// same fill on a row become one rectangle. One file per GitHub colour scheme.
//
//   node dev/mark-svg.js            write docs/assets/lampstand-lockup-{light,dark}.svg
//   node dev/mark-svg.js --check    exit 1 when either file differs from what the text would draw
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "docs", "assets");
/** Fill colours: GitHub's default text colour on light and on dark backgrounds. */
const SCHEMES = { light: "#1f2328", dark: "#e6edf3" };
const PAD = 1;

/** @param {string} text */
export function rects(text) {
  const rows = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").map((line) => Array.from(line));
  /** @type {{ x: number, y: number, w: number, h: number }[]} */
  const out = [];
  rows.forEach((cells, row) => {
    // Two half-rows per character row: the top half is filled by a full or an upper block, the bottom by a full or a
    // lower block.
    for (const [half, fills] of [[0, ["█", "▀"]], [1, ["█", "▄"]]]) {
      let start = -1;
      for (let col = 0; col <= cells.length; col++) {
        const on = col < cells.length && /** @type {string[]} */ (fills).includes(cells[col]);
        if (on && start < 0) start = col;
        if (!on && start >= 0) {
          out.push({ x: start, y: row * 2 + /** @type {number} */ (half), w: col - start, h: 1 });
          start = -1;
        }
      }
    }
  });
  return { rects: out, width: Math.max(...rows.map((r) => r.length)), height: rows.length * 2 };
}

/** @param {string} text @param {string} fill */
export function svg(text, fill) {
  const { rects: boxes, width, height } = rects(text);
  const w = width + PAD * 2, h = height + PAD * 2;
  const body = boxes.map((r) => `<rect x="${r.x + PAD}" y="${r.y + PAD}" width="${r.w}" height="${r.h}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 8}" height="${h * 8}" shape-rendering="crispEdges" role="img" aria-label="lampstand"><title>lampstand</title><g fill="${fill}">${body}</g></svg>\n`;
}

const text = readFileSync(join(ASSETS, "lampstand-lockup.txt"), "utf8");
const check = process.argv.includes("--check");
let stale = 0;
for (const [scheme, fill] of Object.entries(SCHEMES)) {
  const path = join(ASSETS, `lampstand-lockup-${scheme}.svg`);
  const want = svg(text, fill);
  if (check) {
    let have = "";
    try {
      have = readFileSync(path, "utf8");
    } catch {}
    if (have !== want) {
      process.stderr.write(`mark-svg: ${path} differs from docs/assets/lampstand-lockup.txt\n`);
      stale++;
    }
  } else {
    writeFileSync(path, want);
  }
}
process.exitCode = stale > 0 ? 1 : 0;
