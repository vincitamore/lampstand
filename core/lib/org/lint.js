// @ts-check
// Objective lint for org items. An error is a state that is wrong on the file's own evidence: frontmatter that does
// not parse, a missing required field, a kind or status outside the schema, an item outside the folder its status
// belongs in, a field declared a list that holds something else, one stem in two folders of a kind, a link that
// resolves to no file. Anything that depends on what someone meant (a file with no frontmatter in an org folder,
// unless the house says every such file is an item; an overdue reminder; an ambiguous link) is information. Files the
// house names as not items are not linted as items, but their links are checked. Fields are read under the names
// each kind's items give them.
import { indexFiles, isExternalLink, resolveTarget, walkHouse } from "./links.js";
import { findLinks, keyLine, localDate } from "./markdown.js";
import { fieldName, isTerminal, placeFor } from "./schema.js";
import { scanOrg, statusOf, stemOfItem, titleOf } from "./items.js";

/** @typedef {import("./schema.js").OrgSchema} OrgSchema */
/** @typedef {import("./items.js").ItemFile} ItemFile */
/**
 * @typedef {{
 *   level: "error" | "info",
 *   rule: "parse" | "required" | "kind" | "status" | "placement" | "list" | "stem" | "link" | "not-an-item" | "overdue" | "ambiguous-link",
 *   path: string,
 *   line?: number,
 *   message: string,
 * }} LintFinding
 */

/** True for a field value that counts as given. @param {unknown} value */
function present(value) {
  return value !== undefined && value !== null && value !== "";
}

/**
 * True when `item` carries the logical field `field`: `kind` is read from the schema's kind field, a title may come
 * from the first heading when the house says so, a status may be implied by the item's folder, and a field the kind
 * renames is read under its house name.
 * @param {ItemFile} item
 * @param {string} field
 * @param {OrgSchema} schema
 */
function hasField(item, field, schema) {
  const fm = item.frontmatter ?? {};
  if (field === "kind") return present(fm[schema.kindField]);
  const name = fieldName(item.kind, field);
  if (field === "title") return present(fm[name]) || (fm[name] === undefined && titleOf(item, schema) !== undefined);
  if (field === "status") return present(fm[name]) || (fm[name] === undefined && statusOf(item) !== undefined);
  return present(fm[name]);
}

/**
 * @param {string} root
 * @param {OrgSchema} schema
 * @param {{ now?: Date }} [options]
 * @returns {{ findings: LintFinding[], items: ItemFile[] }}
 */
export function lintOrg(root, schema, options = {}) {
  const { items, notes } = scanOrg(root, schema);
  const index = indexFiles(walkHouse(root));
  const today = localDate(options.now);
  /** @type {LintFinding[]} */
  const findings = [];
  /** @param {string} path @param {string} text */
  const checkLinks = (path, text) => {
    for (const link of findLinks(text)) {
      if (isExternalLink(link)) continue;
      const shown = link.syntax === "wiki" ? `[[${link.target}]]` : `(${link.target})`;
      const targets = resolveTarget(index, link.target, path);
      if (targets.length === 0) {
        findings.push({ level: "error", rule: "link", path, line: link.line, message: `${shown} resolves to no file in the house` });
      } else if (targets.length > 1) {
        findings.push({ level: "info", rule: "ambiguous-link", path, line: link.line, message: `${shown} matches ${targets.length} files: ${targets.join(", ")}` });
      }
    }
  };
  for (const item of items) {
    const path = item.rel;
    if (item.error) {
      findings.push({ level: "error", rule: "parse", path, line: item.error.line, message: messageOf(item.error.message, path) });
      continue;
    }
    const fm = item.frontmatter;
    if (!fm) {
      findings.push(
        schema.missingFrontmatter === "error"
          ? { level: "error", rule: "not-an-item", path, line: 1, message: `has no frontmatter; every file in ${item.place}/ is a ${item.kind.name} in this house` }
          : { level: "info", rule: "not-an-item", path, message: `has no frontmatter, so it is not read as a ${item.kind.name}` },
      );
      continue;
    }
    const kind = item.kind;
    for (const field of kind.required) {
      if (hasField(item, field, schema)) continue;
      const name = field === "kind" ? schema.kindField : fieldName(kind, field);
      const heading = field === "title" && schema.titleFallback === "heading" ? " and no level-1 heading" : "";
      findings.push({ level: "error", rule: "required", path, line: 1, message: `missing required field ${name}${heading} (kind ${kind.name})` });
    }
    const named = fm[schema.kindField];
    if (named !== undefined && named !== kind.value) {
      const owners = [...schema.kinds.values()].filter((other) => other.value === named).map((other) => other.name);
      findings.push({
        level: "error",
        rule: "kind",
        path,
        line: keyLine(item.text, schema.kindField),
        message: owners.length > 0
          ? `${schema.kindField} ${JSON.stringify(named)}${owners.length === 1 && owners[0] === named ? "" : ` (kind ${owners.join(" or ")})`} but the file is in ${item.folder}/, a folder of kind ${kind.name}`
          : `${schema.kindField} ${JSON.stringify(named)} is not in the schema (${[...new Set([...schema.kinds.values()].map((other) => other.value))].join(", ")})`,
      });
    }
    const status = statusOf(item);
    const statusField = fieldName(kind, "status");
    const written = fm[statusField];
    if (written !== undefined && (typeof written !== "string" || !kind.statuses.includes(written))) {
      findings.push({
        level: "error",
        rule: "status",
        path,
        line: keyLine(item.text, statusField),
        message: `${statusField} ${JSON.stringify(written)} is not a ${kind.name} status (${kind.statuses.join(", ")})`,
      });
    } else if (status !== undefined) {
      const terminal = isTerminal(kind, status);
      const expected = placeFor(schema, kind, item.folder, status);
      if (item.place !== expected) {
        const resolvedDir = `${item.folder}/${schema.resolvedFolder}`;
        const own = kind.statusFolders.has(status);
        const message = !own && terminal && item.place === item.folder
          ? `status ${status} is terminal but the file is outside ${resolvedDir}/`
          : !own && !terminal && item.place === resolvedDir
            ? `status ${status} is not terminal but the file is inside ${resolvedDir}/`
            : `status ${status} belongs in ${expected}/ but the file is in ${item.place}/`;
        findings.push({ level: "error", rule: "placement", path, line: keyLine(item.text, statusField), message });
      }
      if (terminal) {
        for (const field of schema.resolvedFields) {
          if (field === "resolution" && !kind.resolutionRequired) continue;
          const name = fieldName(kind, field);
          if (!present(fm[name])) {
            findings.push({ level: "error", rule: "required", path, line: 1, message: `missing required field ${name} (status ${status} is terminal)` });
          }
        }
      }
    }
    for (const field of kind.lists) {
      const value = fm[field];
      if (present(value) && !Array.isArray(value)) {
        findings.push({ level: "error", rule: "list", path, line: keyLine(item.text, field), message: `${field} must be a list, found ${JSON.stringify(value)}` });
      }
    }
    const dueField = fieldName(kind, "due");
    const due = fm[dueField];
    if (kind.required.includes("due") && typeof due === "string" && status !== undefined && !isTerminal(kind, status) && due < today) {
      findings.push({ level: "info", rule: "overdue", path, message: `${dueField} ${due}, before today (${today})` });
    }
    checkLinks(path, item.text);
  }
  for (const note of notes) checkLinks(note.rel, note.text);
  findings.push(...stemFindings(items));
  return { findings, items };
}

/**
 * One error per stem found in more than one folder of a kind: an item's identity is its stem, so two such files are
 * a copy where a move was meant, and a later move onto that stem would overwrite one. Reported at the first path.
 * @param {ItemFile[]} items
 * @returns {LintFinding[]}
 */
function stemFindings(items) {
  /** @type {Map<string, ItemFile[]>} */
  const groups = new Map();
  for (const item of items) {
    const key = `${item.kind.name}/${stemOfItem(item).toLowerCase()}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  /** @type {LintFinding[]} */
  const out = [];
  for (const group of groups.values()) {
    const places = new Set(group.map((item) => item.place));
    if (places.size < 2) continue;
    const paths = group.map((item) => item.rel).sort();
    out.push({
      level: "error",
      rule: "stem",
      path: paths[0],
      message: `stem ${stemOfItem(group[0])} is in ${places.size} folders of kind ${group[0].kind.name} (${paths.join(", ")}); an item lives in one`,
    });
  }
  return out;
}

/** The parser's message without its own `path:line:` prefix, since the finding carries both. @param {string} message @param {string} path */
function messageOf(message, path) {
  return message.startsWith(`${path}:`) ? message.replace(/^[^:]*(?::[0-9]+)?: /, "") : message;
}

/** One line per finding: `<level> <path>[:<line>]: <message> [<rule>]`. @param {LintFinding} finding */
export function findingLine(finding) {
  return `${finding.level} ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}: ${finding.message} [${finding.rule}]`;
}
