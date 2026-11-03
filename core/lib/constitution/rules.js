// @ts-check
// The curation rules: objective checks over a parsed house, each a pure function returning findings. An error is a
// state that is wrong on the house's own evidence; anything that depends on taste or intent is information or
// nothing. The set is pinned by an exact-equality test.
import { isAbsolute, relative, sep } from "node:path";
import { budgetFindings, GENERATED_DIR, readHeader } from "./compile.js";

/** @typedef {{ rule: string, level: "error" | "info", message: string, path?: string }} Finding */
/**
 * @typedef {{
 *   house: import("./house.js").House,
 *   compiled: import("./compile.js").Compiled,
 *   previous: import("./compile.js").Manifest | null,
 *   onDisk: Map<string, string> | null,
 *   gates: ReadonlySet<string>,
 * }} RuleInput
 *   `onDisk` maps each file name in .house/generated/ to its text; null when the caller is about to rewrite them.
 *   `gates` is every gate name a provision may cite.
 * @typedef {{ id: string, summary: string, check: (input: RuleInput) => Finding[] }} Rule
 */

/** At most this many surfaces may load unconditionally. */
export const MAX_UNCONDITIONAL_SURFACES = 5;

/** @type {Rule[]} */
export const CURATION_RULES = [
  {
    id: "occasion",
    summary: "every new principle, provision or reflex carries an occasion",
    check({ house }) {
      /** @type {Finding[]} */
      const out = [];
      const missing = (/** @type {string} */ what, /** @type {string} */ path) =>
        out.push({ rule: "occasion", level: "error", message: `${what} carries no occasion`, path });
      for (const p of house.proposals) {
        if (typeof p.frontmatter?.occasion !== "string" || p.frontmatter.occasion.trim() === "") missing(`proposed ${p.kind} ${p.slug}`, p.path);
      }
      for (const file of house.principleFiles) {
        const origin = String(file.frontmatter.origin);
        const occasion = file.frontmatter.occasion;
        if (!origin.startsWith("pack:") && (typeof occasion !== "string" || occasion.trim() === "")) missing(`principle file ${file.slug}`, file.path);
      }
      for (const provision of house.provisions) if (provision.occasion === null) missing(`provision ${provision.slug}`, provision.path);
      for (const reflex of house.reflexes) if (reflex.occasion === null) missing(`reflex ${reflex.slug}`, reflex.path);
      return out;
    },
  },
  {
    id: "failure-mode",
    summary: "every principle carries a failure mode",
    check({ house }) {
      return house.principleFiles.flatMap((file) =>
        file.principles
          .filter((p) => p.failureMode === null)
          .map((p) => ({
            rule: "failure-mode",
            level: /** @type {const} */ ("error"),
            message: `principle ${p.mark} : ${p.name} has no *Vice:* or *Failure mode:* paragraph`,
            path: `${p.path}:${p.line}`,
          })),
      );
    },
  },
  {
    id: "reflex-revisable",
    summary: "every reflex carries a falsification trigger and a revision step",
    check({ house }) {
      /** @type {Finding[]} */
      const out = [];
      for (const reflex of house.reflexes) {
        if (reflex.falsifiedWhen === null) {
          out.push({ rule: "reflex-revisable", level: "error", message: `reflex ${reflex.slug} carries no falsified-when trigger`, path: reflex.path });
        }
        if (reflex.revise === null) {
          out.push({ rule: "reflex-revisable", level: "error", message: `reflex ${reflex.slug} carries no revise step`, path: reflex.path });
        }
      }
      return out;
    },
  },
  {
    id: "budget",
    summary: "budgets and the ratchet hold",
    check({ house, compiled, previous }) {
      return budgetFindings(compiled.manifest, previous, house.mode).map((finding) => ({
        rule: "budget",
        level: finding.level,
        message: finding.message,
      }));
    },
  },
  {
    id: "no-declared-totals",
    summary: "no budget total is declared; totals are derived",
    check({ house }) {
      /** @type {Finding[]} */
      const out = [];
      const budget = /** @type {Record<string, unknown>} */ (house.config.budget ?? {});
      for (const key of Object.keys(budget)) {
        if (/total/i.test(key)) out.push({ rule: "no-declared-totals", level: "error", message: `house.toml declares budget.${key}; totals are derived, never declared`, path: "house.toml" });
      }
      for (const [name, entry] of Object.entries(house.surfaces ?? {})) {
        const keys = typeof entry === "object" && entry !== null ? Object.keys(entry) : [];
        for (const key of /total/i.test(name) ? [""] : keys.filter((k) => /total/i.test(k))) {
          out.push({
            rule: "no-declared-totals",
            level: "error",
            message: `house.toml declares surfaces.${name}${key === "" ? "" : `.${key}`}; totals are derived, never declared`,
            path: "house.toml",
          });
        }
      }
      return out;
    },
  },
  {
    id: "generated-fresh",
    summary: "generated files carry their header and match a fresh compile",
    check({ compiled, onDisk }) {
      if (onDisk === null) return [];
      /** @type {Finding[]} */
      const out = [];
      const expected = new Map(compiled.files.map((file) => [file.name, file.text]));
      for (const [name, text] of expected) {
        const path = `${GENERATED_DIR}/${name}`;
        const actual = onDisk.get(name);
        if (actual === undefined) out.push({ rule: "generated-fresh", level: "error", message: `${path} is missing`, path });
        else if (name.endsWith(".md") && readHeader(actual) === null) out.push({ rule: "generated-fresh", level: "error", message: `${path} has no GENERATED header`, path });
        else if (actual !== text) out.push({ rule: "generated-fresh", level: "error", message: `${path} is stale: it differs from a fresh compile`, path });
      }
      for (const name of onDisk.keys()) {
        if (!expected.has(name)) {
          const path = `${GENERATED_DIR}/${name}`;
          out.push({ rule: "generated-fresh", level: "error", message: `${path} is not produced by the compiler`, path });
        }
      }
      return out;
    },
  },
  {
    id: "provision-gates",
    summary: "every gate a provision names exists",
    check({ house, gates }) {
      return house.provisions.flatMap((provision) =>
        provision.gates
          .filter((gate) => !gates.has(gate))
          .map((gate) => ({
            rule: "provision-gates",
            level: /** @type {const} */ ("error"),
            message: `provision ${provision.slug} names gate ${gate}, which does not exist`,
            path: provision.path,
          })),
      );
    },
  },
  {
    id: "unconditional-surfaces",
    summary: `at most ${MAX_UNCONDITIONAL_SURFACES} surfaces load unconditionally`,
    check({ house }) {
      const always = Object.entries(house.surfaces ?? {})
        .filter(([, entry]) => typeof entry === "object" && entry !== null && /** @type {Record<string, unknown>} */ (entry).loads === "always")
        .map(([name]) => name);
      if (always.length <= MAX_UNCONDITIONAL_SURFACES) return [];
      return [
        {
          rule: "unconditional-surfaces",
          level: "error",
          message: `${always.length} surfaces load unconditionally (${always.join(", ")}); at most ${MAX_UNCONDITIONAL_SURFACES} may`,
          path: "house.toml",
        },
      ];
    },
  },
];

/** Every gate name a provision may cite: the curation rules are the constitution's gates. */
export const KNOWN_GATES = Object.freeze(new Set(CURATION_RULES.map((rule) => rule.id)));

/**
 * Runs every curation rule. Finding paths are house-relative with `/` separators, whatever the parser recorded.
 * @param {RuleInput} input
 * @returns {Finding[]}
 */
export function runRules(input) {
  return CURATION_RULES.flatMap((rule) => rule.check(input)).map((finding) =>
    finding.path !== undefined && isAbsolute(finding.path)
      ? { ...finding, path: relative(input.house.root, finding.path).split(sep).join("/") }
      : finding,
  );
}
