#!/usr/bin/env node
// @ts-check
// The public half of the leak check: patterns that are a leak in anyone's repository, needing no list of the
// maintainer's own names or secrets. Every file the repository holds is read, shipped or not, since the source
// branch is public too. A finding names path, line and kind only: printing the match would repeat the leak in a
// CI log.
import { join } from "node:path";
import { lineIndex, parseArgs, readTextFile, report, runGate, repoFiles } from "./gate-lib.js";

const SEP = String.raw`(?:\\\\|\\|/)`;
// A user name segment; `<name>` in angle brackets is a placeholder, not a user.
const NAME = String.raw`(?!<[^<>\\/\s]+>)[^\\/\s"'\x60<>]+`;

/** @type {{ kind: string, re: RegExp, allow?: (match: RegExpExecArray) => boolean }[]} */
export const PATTERNS = [
  { kind: "home-path", re: new RegExp(String.raw`\b[A-Za-z]:${SEP}Users${SEP}${NAME}${SEP}`, "g") },
  { kind: "home-path", re: new RegExp(String.raw`(?<![\w.-])/(?:Users|home)/${NAME}/`, "g") },
  { kind: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: "openai-anthropic-key", re: /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{32,}/g },
  { kind: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "stripe-key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/g },
  { kind: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "huggingface-token", re: /\bhf_[A-Za-z0-9]{34,}\b/g },
  {
    kind: "email",
    re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g,
    allow: (match) => allowedEmail(match[0], match[1]),
  },
];

/**
 * noreply addresses (a git host's private commit address, or a `noreply@` sender) and the reserved
 * `example.invalid` domain are the only addresses that may appear.
 * @param {string} address
 * @param {string} domain
 */
function allowedEmail(address, domain) {
  const local = address.slice(0, address.length - domain.length - 1).toLowerCase();
  const host = domain.toLowerCase();
  if (local === "noreply" || local === "no-reply") return true;
  if (host.split(".").some((label) => label === "noreply")) return true;
  return host === "example.invalid" || host.endsWith(".example.invalid");
}

runGate("leak-gate", "node dev/leak-gate.js [--root <dir>]", () => {
  const { root } = parseArgs(process.argv.slice(2));
  const findings = [];
  let scanned = 0;
  for (const path of repoFiles(root)) {
    const text = readTextFile(join(root, path));
    if (text === null) continue;
    scanned++;
    const lineOf = lineIndex(text);
    /** @type {Set<string>} */
    const seen = new Set();
    for (const { kind, re, allow } of PATTERNS) {
      re.lastIndex = 0;
      for (let match = re.exec(text); match !== null; match = re.exec(text)) {
        if (allow?.(match)) continue;
        const line = `${path}:${lineOf(match.index)}:${kind}`;
        if (!seen.has(line)) findings.push(line);
        seen.add(line);
      }
    }
  }
  return report("leak-gate", findings, `${scanned} files clean`, `${findings.length} possible leaks (matched text withheld)`);
});
