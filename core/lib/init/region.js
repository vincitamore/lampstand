// @ts-check
// The generated region of the house's AGENTS.md: the lines between `<!-- house:begin -->` and `<!-- house:end -->`.
// It carries the compile header (so a reader can tell a stale region by its input hash), the kernel under its own
// marker (so a host that already carries the region never adds the kernel twice), then whole router sections, each
// under a `<!-- lampstand:section:<name> -->` marker, in router order while the region stays within REGION_CAP
// characters. A section that would overflow is left out and a later, smaller one may still fit; the adapters append
// any router section whose marker is absent. Every byte outside the two marker lines is left exactly as it was.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, errorMessage } from "../io.js";
import { fail } from "../errors.js";
import { chars } from "../constitution/budgets.js";
import { projectionMarker } from "../constitution/compile.js";
import { HOSTS } from "../constitution/parse.js";

/** @typedef {import("../constitution/compile.js").Compiled} Compiled */

export const AGENTS_FILE = "AGENTS.md";
export const REGION_BEGIN = "<!-- house:begin -->";
export const REGION_END = "<!-- house:end -->";
/** K plus router sections, in characters (code points), the same unit every budget is measured in. */
export const REGION_CAP = 12_000;

/**
 * The router's sections, in the order the compiler assembles them, with the manifest key that measures each body and
 * the files it is compiled from. `host` in a key is replaced by the host name.
 */
const SECTIONS = Object.freeze([
  { name: "principles", title: "Principle detail", key: "principle-detail", source: "principles/" },
  { name: "charter", title: "Charter", key: "charter-core", source: "charter/" },
  { name: "reflexes", title: "Reflexes", key: "reflex-index:host", source: "reflexes/" },
  { name: "voice", title: "Voice", key: "voice", source: "voice.md" },
]);

/**
 * The non-empty sections of one host's router projection, cut from its text by the body sizes the manifest records,
 * so a body that itself holds a `## ` heading is never split at it. A layout that does not reassemble to the exact
 * projection text is a compiler change this module has not followed, and is refused loudly. The host adapters use it
 * to append only the sections the region did not carry.
 * @param {string} text  router.<host>.md as written (LF)
 * @param {string} kernel  the kernel body every projection opens with
 * @param {Record<string, { chars: number }>} surfaces  the manifest's surfaces
 * @param {string} host
 * @returns {{ name: string, title: string, body: string }[]}
 */
export function splitRouter(text, kernel, surfaces, host) {
  const header = text.slice(0, text.indexOf("\n"));
  const prefix = `${header}\n${projectionMarker(`router:${host}`)}\n${kernel}`;
  if (!text.startsWith(prefix)) throw new Error(`router.${host}.md does not open with its header, marker and the kernel`);
  const rest = Array.from(text.slice(prefix.length));
  let at = 0;
  /** @type {{ name: string, title: string, body: string }[]} */
  const out = [];
  for (const section of SECTIONS) {
    const size = surfaces[section.key.replace(/:host$/, `:${host}`)];
    if (!size) throw new Error(`the manifest measures no ${section.key} surface`);
    if (size.chars === 0) continue;
    const lead = `\n\n## ${section.title}\n\n`;
    const leadChars = Array.from(lead);
    if (rest.slice(at, at + leadChars.length).join("") !== lead) throw new Error(`router.${host}.md has no ${section.title} section where expected`);
    at += leadChars.length;
    out.push({ name: section.name, title: section.title, body: rest.slice(at, at + size.chars).join("") });
    at += size.chars;
  }
  if (rest.slice(at).join("") !== "\n") throw new Error(`router.${host}.md has text after its last section`);
  return out;
}

/**
 * @param {Compiled} compiled
 * @param {string} host
 */
function routerSections(compiled, host) {
  const file = compiled.files.find((candidate) => candidate.name === `router.${host}.md`);
  if (!file) throw new Error(`the compiler produced no router.${host}.md`);
  return splitRouter(file.text, compiled.kernel, compiled.manifest.surfaces, host);
}

/** Room kept under REGION_CAP for the line that names the sections left out. */
const OMITTED_RESERVE = 400;

/**
 * The region's text, without the marker lines. Sections whose body differs between hosts (a host-scoped reflex) are
 * left to each host's adapter, and so is a section too large to fit; a closing line names every section left out and
 * the files it is compiled from, since a host without the OMP adapter loads only this region.
 * @param {Compiled} compiled
 */
export function renderRegion(compiled) {
  const kernelFile = compiled.files.find((file) => file.name === "kernel.md");
  if (!kernelFile) throw new Error("the compiler produced no kernel.md");
  const header = kernelFile.text.slice(0, kernelFile.text.indexOf("\n"));
  const perHost = HOSTS.map((host) => routerSections(compiled, host));
  const [first, ...others] = perHost;
  const shared = first.filter((section) =>
    others.every((sections) => sections.some((other) => other.name === section.name && other.body === section.body)),
  );
  let text = `${header}\n${projectionMarker("kernel")}\n${compiled.kernel}`;
  /** @type {Set<string>} */
  const carried = new Set();
  for (const section of shared) {
    const block = `\n\n${projectionMarker(`section:${section.name}`)}\n## ${section.title}\n\n${section.body}`;
    if (chars(text) + chars(block) <= REGION_CAP - OMITTED_RESERVE) {
      text += block;
      carried.add(section.name);
    }
  }
  const present = new Set(perHost.flat().map((section) => section.name));
  const omitted = SECTIONS.filter((section) => present.has(section.name) && !carried.has(section.name));
  if (omitted.length > 0) {
    const named = omitted.map((section) => `${section.title} (\`${section.source}\`)`).join(", ");
    text += `\n\nNot in this region, for size or because it differs between hosts: ${named}. The OMP plugin adds these to each session; elsewhere, read those files when the work calls for them.`;
  }
  return text;
}

/**
 * Where the region sits in `text`: the offsets just after the begin marker and at the start of the end marker.
 * Null when the markers are not each present once as whole lines, begin before end.
 * @param {string} text
 */
export function findRegion(text) {
  const lines = text.split("\n");
  const begin = lines.flatMap((line, k) => (line.replace(/\r$/, "") === REGION_BEGIN ? [k] : []));
  const end = lines.flatMap((line, k) => (line.replace(/\r$/, "") === REGION_END ? [k] : []));
  if (begin.length !== 1 || end.length !== 1 || end[0] <= begin[0]) return null;
  const offset = (/** @type {number} */ line) => lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0);
  const crlf = lines[begin[0]].endsWith("\r");
  return { from: offset(begin[0] + 1), to: offset(end[0]), eol: crlf ? "\r\n" : "\n" };
}

/**
 * `text` with the region emptied: what the file was when planted. Planted-file hashes of AGENTS.md are taken over
 * this, so a compile never makes an unedited AGENTS.md look edited. Text without a region is returned whole.
 * @param {string} text
 */
export function blankRegion(text) {
  const region = findRegion(text);
  return region === null ? text : `${text.slice(0, region.from)}${text.slice(region.to)}`;
}

/**
 * @param {string} text  the whole file
 * @param {string} body  the region text, LF-separated
 * @returns {string | null}  the file with its region replaced, or null when it has no region
 */
export function withRegion(text, body) {
  const region = findRegion(text);
  if (region === null) return null;
  const inner = `${body}\n`.replaceAll("\n", region.eol);
  return `${text.slice(0, region.from)}${inner}${text.slice(region.to)}`;
}

/**
 * Writes the region of the house's AGENTS.md from a compile result. The file is read and written as raw bytes, so
 * nothing outside the markers changes, line endings included; an unchanged region writes nothing.
 * @param {string} root
 * @param {Compiled} compiled
 * @returns {{ path: string, status: "written" | "unchanged" | "no-file" | "no-region" }}
 */
export function writeAgentsRegion(root, compiled) {
  const path = join(root, AGENTS_FILE);
  if (!existsSync(path)) return { path, status: "no-file" };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw fail("E_IO", `cannot read: ${errorMessage(cause)}`, { path, cause });
  }
  const next = withRegion(text, renderRegion(compiled));
  if (next === null) return { path, status: "no-region" };
  if (next === text) return { path, status: "unchanged" };
  atomicWrite(path, next, { lf: false });
  return { path, status: "written" };
}

/**
 * Whether the house's AGENTS.md carries a region that differs from what `compiled` would write there.
 * @param {string} root
 * @param {Compiled} compiled
 */
export function agentsRegionStale(root, compiled) {
  const path = join(root, AGENTS_FILE);
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  const next = withRegion(text, renderRegion(compiled));
  return next !== null && next !== text;
}

/** The message for a region that cannot be written. @param {"no-file" | "no-region"} status */
export function regionProblem(status) {
  return status === "no-file"
    ? `${AGENTS_FILE} is missing, so the house's generated region has nowhere to go`
    : `${AGENTS_FILE} has no generated region: put a line ${REGION_BEGIN} and, below it, a line ${REGION_END} where the region should go`;
}
