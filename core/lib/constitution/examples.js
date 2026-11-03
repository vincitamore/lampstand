// @ts-check
// The smallest file an author writes for each kind of proposal, shown by `lampstand propose --help`. Each example is
// parsed by the real parser in the tests, so the help cannot drift from what `propose` accepts.
import { KINDS } from "./parse.js";

/** @typedef {import("./parse.js").Kind} Kind */

/** What the author writes, by kind. `propose` adds `occasion` (from --occasion) and `proposed` (today) itself. */
export const PROPOSAL_EXAMPLES = Object.freeze(
  /** @type {Record<Kind, { file: string, text: string, notes: string[] }>} */ ({
    principle: {
      file: "stewardship.md",
      text: [
        "### so : Stewardship",
        "",
        "*Leave the house better than you found it.*",
        "",
        "- **practical**: tidy what you touch.",
        "- **relational**: hand over what the next person needs.",
        "",
        "*Failure mode:* polishing what nobody uses.",
        "",
      ].join("\n"),
      notes: [
        "A heading `### <mark> : <Name>`, an italic one-sentence thesis, `- **facet**: text` bullets, and a `*Failure mode:*` (or `*Vice:*`) paragraph.",
        "One file may hold several principles. No frontmatter is needed; adopt adds `origin: own`.",
      ],
    },
    provision: {
      file: "commit-as-it-lands.md",
      text: ["# Commit as it lands", "", "Commit each finished piece of work in the step that finishes it, not in a batch at the end.", ""].join("\n"),
      notes: ["A `# <title>` line, then the provision's text. No frontmatter is needed; add `gates: [<gate>]` only to name gates the provision relies on."],
    },
    reflex: {
      file: "read-first.md",
      text: [
        "---",
        "scope: behavioral",
        "summary: Read a file before editing it.",
        "falsified-when: Edits land clean without reading first.",
        "revise: Narrow the rule to large files.",
        "---",
        "Read the file before you edit it; an edit made from memory lands on a stale anchor.",
        "",
      ].join("\n"),
      notes: [
        "Frontmatter `scope` (behavioral, architectural, tool:hermes or tool:omp) and `summary` (one line, shown in the reflex index) are required;",
        "`falsified-when` and `revise` are required before adoption. The body is free text.",
      ],
    },
  }),
);

/**
 * Help text for `lampstand propose`: the example for the named kind, or all three when none is named.
 * @param {string[]} args  the positional arguments given with --help
 */
export function proposeHelp(args) {
  const named = /** @type {Kind[]} */ (KINDS.filter((kind) => kind === args[0]));
  const shown = named.length > 0 ? named : KINDS;
  const parts = [
    "A proposal is a Markdown file named <slug>.md (lowercase letters, digits and hyphens); the slug names it for `adopt --ids <kind>/<slug>`.",
    "propose adds the frontmatter keys `occasion` (from --occasion) and `proposed` (today's date) itself; do not write them.",
  ];
  for (const kind of shown) {
    const example = PROPOSAL_EXAMPLES[kind];
    parts.push("", `example ${kind} (${example.file}):`, ...example.text.trimEnd().split("\n").map((line) => `  ${line}`), ...example.notes);
  }
  return parts.join("\n");
}
