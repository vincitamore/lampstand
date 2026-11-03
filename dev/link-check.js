#!/usr/bin/env node
// @ts-check
// Every relative link and image in every Markdown file the repository holds must resolve to a file (or a directory
// holding files) in the repository: inline `[text](target)` and `![alt](target)`, reference definitions
// `[id]: target`, and the `href`/`src` of inline HTML. Code spans and fenced blocks are examples, not links. A target
// with a scheme (`https:`, `mailto:`), a protocol-relative `//host` or a bare `#fragment` is not relative. A leading
// `/` is read from the repository root, as the forge renders it.
import { join, posix } from "node:path";
import { maskCode } from "../core/lib/org/markdown.js";
import { lineIndex, parseArgs, readTextFile, report, runGate, repoFiles } from "./gate-lib.js";

// `](` then a destination: `<...>` or a run without spaces, with balanced parentheses one level deep.
const INLINE = /\]\(\s*(<[^<>\n]*>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^<>\n]*>|\S+)/gm;
const HTML = /<(?:a|img|source|link)\b[^>]*?\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** @param {string} raw */
function destination(raw) {
  const target = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  if (target === "" || target.startsWith("#") || target.startsWith("//")) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;
  const path = target.replace(/[?#].*$/s, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

runGate("link-check", "node dev/link-check.js [--root <dir>]", () => {
  const { root } = parseArgs(process.argv.slice(2));
  const files = repoFiles(root);
  const present = new Set(files);
  const dirs = new Set();
  for (const file of files) for (let d = posix.dirname(file); d !== "."; d = posix.dirname(d)) dirs.add(d);
  const findings = [];
  let links = 0;
  const markdown = files.filter((path) => path.toLowerCase().endsWith(".md"));
  for (const path of markdown) {
    const text = readTextFile(join(root, path));
    if (text === null) continue;
    const masked = maskCode(text);
    const lineOf = lineIndex(text);
    /** @type {{ at: number, raw: string }[]} */
    const targets = [];
    for (const re of [INLINE, DEFINITION]) {
      re.lastIndex = 0;
      for (let m = re.exec(masked); m !== null; m = re.exec(masked)) targets.push({ at: m.index, raw: m[1] });
    }
    HTML.lastIndex = 0;
    for (let m = HTML.exec(masked); m !== null; m = HTML.exec(masked)) targets.push({ at: m.index, raw: m[1] ?? m[2] });
    targets.sort((a, b) => a.at - b.at);
    for (const { at, raw } of targets) {
      const target = destination(raw);
      if (target === null) continue;
      links++;
      const resolved = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(path), target));
      const key = resolved.replace(/\/+$/, "");
      const ok = !key.startsWith("..") && (present.has(key) || dirs.has(key) || key === ".");
      if (!ok) findings.push(`${path}:${lineOf(at)}: ${raw} does not resolve to a file in the repository`);
    }
  }
  return report("link-check", findings, `${links} relative links in ${markdown.length} Markdown files resolve`, `${findings.length} broken links`);
});
