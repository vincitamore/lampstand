#!/usr/bin/env node
// @ts-check
// SECURITY.md says what lampstand runs; this gate keeps that true. It reads every .js, .ts and .py file under core/
// and hosts/, finds each call that starts a process (child_process spawn/exec/fork, Bun.spawn, subprocess, os.system,
// os.exec*, os.spawn*), and works out the command each can start: a string literal at the call, a constant it names
// (in the same file or imported from another), a PATH lookup by name (`which("git")`), a path joined onto a name, or,
// when the command is a parameter, the literals every caller of that wrapper passes. Each command name must appear in
// SECURITY.md. A command the scan cannot name (a job's own argv, $EDITOR) is a dynamic site: it passes only with a
// disposition in dev/disclosure-dispositions.json whose `covers` phrases all appear in SECURITY.md.
//
// The scan is lexical: strings, comments and regular expressions are masked so their text is never read as code, and
// brackets are matched over what remains. It reads the shapes this codebase writes, not every program a language
// allows; an unrecognised shape is reported as dynamic rather than guessed at.
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { GateError, lineIndex, parseArgs, readTextFile, report, runGate, repoFiles } from "./gate-lib.js";

export const DISPOSITIONS_FILE = "dev/disclosure-dispositions.json";
const SCANNED = /^(?:core|hosts)\/.*\.(?:js|ts|py)$/;
const MAX_DEPTH = 24;

/** @typedef {{ start: number, end: number, value: string, interpolated: boolean }} Literal */
/**
 * @typedef {{
 *   name: string | null, method: boolean, params: (string | null)[], start: number, bodyStart: number, bodyEnd: number,
 *   returns: [number, number][]
 * }} Fn
 */
/**
 * @typedef {{
 *   path: string, py: boolean, text: string, masked: string, literals: Map<number, Literal>, lineOf: (at: number) => number,
 *   fns: Fn[]
 * }} Source
 */
/** @typedef {{ src: Source, fn: Fn, index: number }} ParamRef */
/** @typedef {{ names: Map<string, Set<string>>, dynamic: string[], params: ParamRef[] }} Resolution */
/** @typedef {Map<Fn, { src: Source, args: [number, number][], site: string, env: Env }>} Env */

// ---------------------------------------------------------------------------------------------------------------
// Masking: strings and regex literals become `_` runs (newlines kept), comments become spaces, so offsets map 1:1.

/** @param {string} text @param {number} from @param {number} to @param {string} fill @param {string[]} out */
function blank(text, from, to, fill, out) {
  for (let k = from; k < to; k++) out[k] = text[k] === "\n" ? "\n" : fill;
}

/** @param {string} raw */
function decode(raw) {
  return raw.replace(/\\(.)/gs, (_, c) => ({ n: "\n", t: "\t", r: "\r", 0: "\0" })[/** @type {"n"} */ (c)] ?? c);
}

const REGEX_AFTER = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", ""]);
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * @param {string} text
 * @returns {{ masked: string, literals: Map<number, Literal> }}
 */
function maskJs(text) {
  const out = text.split("");
  /** @type {Map<number, Literal>} */
  const literals = new Map();
  let prev = "";
  /** @type {number[]} */
  const templateDepth = [];
  let braces = 0;
  let i = 0;

  /** Scans a template from just after a backtick or a closing `}`; returns the index after its end or its next `${`. */
  const templateRun = (/** @type {number} */ from) => {
    let k = from;
    while (k < text.length) {
      if (text[k] === "\\") k += 2;
      else if (text[k] === "`") return { end: k + 1, open: false };
      else if (text[k] === "$" && text[k + 1] === "{") return { end: k + 2, open: true };
      else k++;
    }
    return { end: k, open: false };
  };

  /** @type {{ start: number, raw: string[], interpolated: boolean }[]} */
  const openTemplates = [];
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(text, i, stop, " ", out);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(text, i, stop, " ", out);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < text.length && text[k] !== c && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
      const end = Math.min(k + 1, text.length);
      literals.set(i, { start: i, end, value: decode(text.slice(i + 1, k)), interpolated: false });
      blank(text, i + 1, k, "_", out);
      i = end;
      prev = "a";
      continue;
    }
    if (c === "`" || (c === "}" && templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braces)) {
      const resuming = c === "}";
      if (resuming) templateDepth.pop();
      const record = resuming ? /** @type {(typeof openTemplates)[number]} */ (openTemplates.pop()) : { start: i, raw: [], interpolated: false };
      const run = templateRun(i + 1);
      record.raw.push(text.slice(i + 1, run.open ? run.end - 2 : run.end - 1));
      blank(text, i + 1, run.open ? run.end - 2 : run.end - 1, "_", out);
      if (run.open) {
        record.interpolated = true;
        record.raw.push("${}");
        openTemplates.push(record);
        templateDepth.push(braces);
      } else {
        literals.set(record.start, { start: record.start, end: run.end, value: record.raw.join(""), interpolated: record.interpolated });
      }
      i = run.end;
      prev = run.open ? "{" : "a";
      continue;
    }
    if (c === "/" && (REGEX_AFTER.has(prev) || REGEX_AFTER_WORD.test(text.slice(Math.max(0, i - 12), i).trimEnd()))) {
      let k = i + 1;
      let inClass = false;
      while (k < text.length && text[k] !== "\n") {
        if (text[k] === "\\") k += 2;
        else if (text[k] === "[") (inClass = true), k++;
        else if (text[k] === "]") (inClass = false), k++;
        else if (text[k] === "/" && !inClass) break;
        else k++;
      }
      k++;
      while (k < text.length && /[a-z]/i.test(text[k])) k++;
      blank(text, i + 1, k, "_", out);
      i = k;
      prev = "a";
      continue;
    }
    if (c === "{") braces++;
    else if (c === "}") braces--;
    if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? "a" : c;
    i++;
  }
  return { masked: out.join(""), literals };
}

/**
 * @param {string} text
 * @returns {{ masked: string, literals: Map<number, Literal> }}
 */
function maskPy(text) {
  const out = text.split("");
  /** @type {Map<number, Literal>} */
  const literals = new Map();
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(text, i, stop, " ", out);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let start = i;
      while (start > 0 && /[rRbBuUfF]/.test(text[start - 1]) && i - start < 2) start--;
      if (start > 0 && /[\w]/.test(text[start - 1])) start = i;
      const prefix = text.slice(start, i).toLowerCase();
      const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let k = i + quote.length;
      while (k < text.length && !text.startsWith(quote, k) && (quote.length === 3 || text[k] !== "\n")) k += text[k] === "\\" ? 2 : 1;
      const body = text.slice(i + quote.length, k);
      const end = Math.min(k + quote.length, text.length);
      const interpolated = prefix.includes("f") && /\{(?!\{)/.test(body.replaceAll("{{", ""));
      literals.set(start, { start, end, value: prefix.includes("r") ? body : decode(body), interpolated });
      blank(text, i + quote.length, k, "_", out);
      i = end;
      continue;
    }
    i++;
  }
  return { masked: out.join(""), literals };
}

// ---------------------------------------------------------------------------------------------------------------
// Structure: matching brackets, splitting top-level lists, finding statement ends and functions.

const OPEN = "([{";
const CLOSE = ")]}";

/** Index of the bracket closing the one at `at`, or -1. @param {string} masked @param {number} at */
function closing(masked, at) {
  let depth = 0;
  for (let k = at; k < masked.length; k++) {
    if (OPEN.includes(masked[k])) depth++;
    else if (CLOSE.includes(masked[k])) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Top-level comma-separated items between `from` and `to`, trimmed, as [start, end) ranges.
 * @param {string} masked @param {number} from @param {number} to
 * @returns {[number, number][]}
 */
function splitList(masked, from, to) {
  /** @type {[number, number][]} */
  const items = [];
  let depth = 0;
  let start = from;
  for (let k = from; k <= to; k++) {
    const c = k === to ? "," : masked[k];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === "," && depth === 0) {
      const range = trim(masked, start, k);
      if (range[1] > range[0]) items.push(range);
      start = k + 1;
    }
  }
  return items;
}

/** @param {string} masked @param {number} start @param {number} end @returns {[number, number]} */
function trim(masked, start, end) {
  while (start < end && /\s/.test(masked[start])) start++;
  while (end > start && /\s/.test(masked[end - 1])) end--;
  return [start, end];
}

/**
 * The end of the expression starting at `from`: the first top-level `;`, `,` or closing bracket, or a top-level line
 * break that does not continue the expression.
 * @param {Source} src @param {number} from
 */
function expressionEnd(src, from) {
  const { masked, py } = src;
  let depth = 0;
  for (let k = from; k < masked.length; k++) {
    const c = masked[k];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      if (depth === 0) return k;
      depth--;
    } else if (depth === 0 && (c === ";" || c === ",")) return k;
    else if (depth === 0 && c === "\n") {
      if (py) {
        if (masked[k - 1] !== "\\") return k;
        continue;
      }
      const before = masked.slice(from, k).trimEnd();
      const after = masked.slice(k + 1).trimStart();
      const continues = /[=+\-*/%&|^!?:<>,.(\[{]$/.test(before) || /^(?:[.?:+\-*/%&|^]|\?\?|\|\||&&)/.test(after);
      if (!continues) return k;
    }
  }
  return masked.length;
}

const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "typeof", "await", "new"]);

/** @param {string} masked @param {number} from @param {number} to */
function paramNames(masked, from, to) {
  return splitList(masked, from, to).map(([s, e]) => {
    const name = /^(?:\.\.\.|\*{1,2})?([A-Za-z_$][\w$]*)/.exec(masked.slice(s, e));
    return name ? name[1] : null;
  });
}

/** @param {Source} src @returns {Fn[]} */
function findFunctions(src) {
  const { masked } = src;
  /** @type {Fn[]} */
  const fns = [];
  if (src.py) {
    const def = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;
    for (let m = def.exec(masked); m !== null; m = def.exec(masked)) {
      const open = m.index + m[0].length - 1;
      const close = closing(masked, open);
      if (close < 0) continue;
      const colon = masked.indexOf(":", masked.lastIndexOf(")", masked.indexOf("\n", close) < 0 ? masked.length : masked.indexOf("\n", close)));
      const indent = m[1].length;
      const bodyStart = colon + 1;
      let bodyEnd = masked.length;
      const line = /\n([ \t]*)(\S)/g;
      line.lastIndex = bodyStart;
      for (let l = line.exec(masked); l !== null; l = line.exec(masked)) {
        if (l[1].length <= indent) {
          bodyEnd = l.index;
          break;
        }
      }
      const params = paramNames(masked, open + 1, close);
      const method = params[0] === "self" || params[0] === "cls";
      fns.push({ name: m[2], method, params: method ? params.slice(1) : params, start: m.index + m[1].length, bodyStart, bodyEnd, returns: [] });
    }
  } else {
    /** @param {string | null} name @param {boolean} method @param {number} start @param {number} open */
    const add = (name, method, start, open) => {
      const close = closing(masked, open);
      if (close < 0) return;
      const rest = masked.slice(close + 1);
      const arrow = /^\s*(?::[^={]*?)?=>\s*/.exec(rest);
      const brace = /^\s*(?::[^{]*?)?\{/.exec(rest);
      let bodyStart;
      let bodyEnd;
      /** @type {[number, number][]} */
      const returns = [];
      if (arrow && masked[close + 1 + arrow[0].length] !== "{") {
        bodyStart = close + 1 + arrow[0].length;
        bodyEnd = expressionEnd(src, bodyStart);
        returns.push(trim(masked, bodyStart, bodyEnd));
      } else if (arrow || brace) {
        bodyStart = masked.indexOf("{", close);
        bodyEnd = closing(masked, bodyStart);
        if (bodyEnd < 0) return;
      } else return;
      fns.push({ name, method, params: paramNames(masked, open + 1, close), start, bodyStart, bodyEnd, returns });
    };
    const decl = /\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g;
    for (let m = decl.exec(masked); m !== null; m = decl.exec(masked)) add(m[1] ?? null, false, m.index, m.index + m[0].length - 1);
    const bound = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/g;
    for (let m = bound.exec(masked); m !== null; m = bound.exec(masked)) add(m[1], false, m.index, m.index + m[0].length - 1);
    const method = /^[ \t]*(?:(?:static|async|public|private|protected)\s+)*([A-Za-z_$][\w$]*)\s*\(/gm;
    for (let m = method.exec(masked); m !== null; m = method.exec(masked)) {
      if (JS_KEYWORDS.has(m[1])) continue;
      const open = m.index + m[0].length - 1;
      const close = closing(masked, open);
      if (close >= 0 && /^\s*(?::[^{;]*?)?\{/.test(masked.slice(close + 1)) && !/=>/.test(masked.slice(close + 1, masked.indexOf("{", close)))) {
        add(m[1], true, m.index, open);
      }
    }
    const anonymous = /(?<![\w$])(?:async\s*)?\(/g;
    for (let m = anonymous.exec(masked); m !== null; m = anonymous.exec(masked)) {
      const open = m.index + m[0].length - 1;
      const close = closing(masked, open);
      if (close < 0 || !/^\s*(?::[^=]*?)?=>/.test(masked.slice(close + 1))) continue;
      if (/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]*)?=\s*(?:async\s*)?$/.test(masked.slice(0, m.index + m[0].length - 1))) continue;
      add(null, false, m.index, open);
    }
    const single = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
    for (let m = single.exec(masked); m !== null; m = single.exec(masked)) {
      const bodyStart = m.index + m[0].length;
      const at = masked.slice(bodyStart).search(/\S/) + bodyStart;
      const block = masked[at] === "{";
      const bodyEnd = block ? closing(masked, at) : expressionEnd(src, at);
      fns.push({ name: null, method: false, params: [m[1]], start: m.index, bodyStart: block ? at : bodyStart, bodyEnd, returns: block ? [] : [trim(masked, at, bodyEnd)] });
    }
  }
  const unique = new Map(fns.map((fn) => [`${fn.start}:${fn.bodyStart}`, fn]));
  const all = [...unique.values()].sort((a, b) => a.start - b.start);
  for (const fn of all) {
    const ret = src.py ? /(?<![\w.])return[ \t]+/g : /(?<![\w$.])return\b\s*/g;
    ret.lastIndex = fn.bodyStart;
    for (let m = ret.exec(masked); m !== null && m.index < fn.bodyEnd; m = ret.exec(masked)) {
      const owner = innermost(all, m.index);
      if (owner !== fn) continue;
      const start = m.index + m[0].length;
      const end = expressionEnd(src, start);
      if (end > start) fn.returns.push(trim(masked, start, end));
    }
  }
  return all;
}

/** @param {Fn[]} fns @param {number} at */
function innermost(fns, at) {
  /** @type {Fn | null} */
  let best = null;
  for (const fn of fns) if (fn.bodyStart <= at && at < fn.bodyEnd && (best === null || fn.bodyStart >= best.bodyStart)) best = fn;
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution: what command names an expression can evaluate to.

/** @returns {Resolution} */
function empty() {
  return { names: new Map(), dynamic: [], params: [] };
}

/** @param {Resolution} into @param {Resolution} from */
function merge(into, from) {
  for (const [name, sites] of from.names) {
    const set = into.names.get(name) ?? new Set();
    for (const site of sites) set.add(site);
    into.names.set(name, set);
  }
  into.dynamic.push(...from.dynamic);
  into.params.push(...from.params);
  return into;
}

/** @param {string} name @param {string} site @returns {Resolution} */
function named(name, site) {
  const out = empty();
  out.names.set(name, new Set([site]));
  return out;
}

/** @param {string} why @returns {Resolution} */
function dynamic(why) {
  const out = empty();
  out.dynamic.push(why);
  return out;
}

/** The program a command string starts: its first word, unquoted, as a file name. @param {string} command */
function commandName(command) {
  const word = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command);
  const raw = word ? (word[1] ?? word[2] ?? word[3]) : "";
  return raw.split(/[\\/]/).pop() ?? "";
}

/**
 * Top-level positions of `op` in [s, e), skipping brackets.
 * @param {string} masked @param {number} s @param {number} e @param {RegExp} op  sticky
 */
function topLevel(masked, s, e, op) {
  const hits = [];
  let depth = 0;
  for (let k = s; k < e; k++) {
    const c = masked[k];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (depth === 0) {
      op.lastIndex = k;
      const m = op.exec(masked);
      if (m && m.index === k) {
        hits.push({ at: k, length: m[0].length });
        k += m[0].length - 1;
      }
    }
  }
  return hits;
}

class Resolver {
  /** @param {Map<string, Source>} sources */
  constructor(sources) {
    this.sources = sources;
    /** @type {Set<string>} */
    this.active = new Set();
  }

  /**
   * @param {Source} src @param {number} s @param {number} e @param {{ site: string, shell: boolean, env: Env, depth: number }} ctx
   * @returns {Resolution}
   */
  expr(src, s, e, ctx) {
    [s, e] = trim(src.masked, s, e);
    const key = `${src.path}:${s}:${e}:${ctx.shell}`;
    if (ctx.depth > MAX_DEPTH || this.active.has(key)) return dynamic(src.text.slice(s, e));
    this.active.add(key);
    try {
      return this.exprInner(src, s, e, ctx);
    } finally {
      this.active.delete(key);
    }
  }

  /**
   * @param {Source} src @param {number} s @param {number} e @param {{ site: string, shell: boolean, env: Env, depth: number }} ctx
   * @returns {Resolution}
   */
  exprInner(src, s, e, ctx) {
    const { masked, text, py } = src;
    const code = masked.slice(s, e);
    const deeper = { ...ctx, depth: ctx.depth + 1 };
    if (s >= e) return empty();
    if (OPEN.includes(code[0]) && closing(masked, s) === e - 1) {
      const items = splitList(masked, s + 1, e - 1);
      if (code[0] === "{") return dynamic(text.slice(s, e));
      if (items.length === 0) return empty();
      if (code[0] === "(" && items.length === 1) return this.expr(src, s + 1, e - 1, deeper);
      return this.expr(src, items[0][0], items[0][1], { ...deeper, shell: false });
    }
    const alternatives = topLevel(masked, s, e, py ? /(?<![\w])or(?![\w])/y : /\?\?|\|\|/y);
    if (alternatives.length > 0) {
      const out = empty();
      let from = s;
      for (const hit of [...alternatives, { at: e, length: 0 }]) {
        merge(out, this.expr(src, from, hit.at, deeper));
        from = hit.at + hit.length;
      }
      return out;
    }
    if (py) {
      const iff = topLevel(masked, s, e, /(?<![\w])if(?![\w])/y);
      const otherwise = topLevel(masked, s, e, /(?<![\w])else(?![\w])/y);
      if (iff.length > 0 && otherwise.length > 0) {
        return merge(this.expr(src, s, iff[0].at, deeper), this.expr(src, otherwise[0].at + 4, e, deeper));
      }
    } else {
      const question = topLevel(masked, s, e, /\?(?![.?])/y);
      if (question.length > 0) {
        const colon = topLevel(masked, question[0].at + 1, e, /:/y);
        if (colon.length > 0) return merge(this.expr(src, question[0].at + 1, colon[0].at, deeper), this.expr(src, colon[0].at + 1, e, deeper));
      }
    }
    // A path joined onto a name ends in the command's file name; a name with a suffix appended is still that command.
    const slash = py ? topLevel(masked, s, e, /\/(?!\/)/y) : [];
    if (slash.length > 0) return this.expr(src, slash[slash.length - 1].at + 1, e, deeper);
    const plus = topLevel(masked, s, e, /\+/y);
    if (plus.length > 0) return this.expr(src, s, plus[0].at, deeper);

    const literal = src.literals.get(s);
    if (literal && literal.end === e) {
      if (literal.interpolated) {
        const head = literal.value.split("${}")[0];
        const lead = py ? literal.value.split(/\{(?!\{)/)[0] : head;
        if (ctx.shell && /^\s*[^\s"'{$]+\s/.test(lead)) return named(commandName(lead), ctx.site);
        return dynamic(text.slice(s, e));
      }
      const name = ctx.shell ? commandName(literal.value) : literal.value.split(/[\\/]/).pop() ?? "";
      return name === "" ? dynamic(text.slice(s, e)) : named(name, ctx.site);
    }
    if (/^(?:null|undefined|None|false|False)$/.test(code)) return empty();
    if (code === "process.execPath") return named("node", ctx.site);
    if (code === "sys.executable") return named("python", ctx.site);
    if (/^[A-Za-z_$][\w$]*$/.test(code)) return this.identifier(src, s, code, ctx);

    const call = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/.exec(code);
    if (call && closing(masked, s + call[0].length - 1) === e - 1) {
      const open = s + call[0].length - 1;
      const args = splitList(masked, open + 1, e - 1);
      const callee = call[1].replace(/\s+/g, "");
      const last = callee.split(".").pop() ?? "";
      if (args.length > 0) {
        const first = src.literals.get(args[0][0]);
        if (first && first.end === args[0][1] && !first.interpolated) return this.expr(src, args[0][0], args[0][1], deeper);
      }
      if (/^(?:str|String|os\.fspath)$/.test(callee) && args.length === 1) return this.expr(src, args[0][0], args[0][1], deeper);
      if (/^(?:join|resolve|(?:path|posix|win32|os\.path)\.(?:join|resolve))$/.test(callee) && args.length > 0) {
        const tail = args[args.length - 1];
        return this.expr(src, tail[0], tail[1], deeper);
      }
      const fn = this.findCallee(src, last);
      if (fn) {
        const out = empty();
        const env = new Map(ctx.env);
        env.set(fn.fn, { src, args, site: ctx.site, env: ctx.env });
        for (const [rs, re] of fn.fn.returns) merge(out, this.expr(fn.src, rs, re, { ...deeper, env }));
        if (out.dynamic.length > 0) out.dynamic = [text.slice(s, e)];
        return out;
      }
    }
    return dynamic(text.slice(s, e));
  }

  /** A function named `name` in `src` or in a module `src` imports it from. @param {Source} src @param {string} name */
  findCallee(src, name) {
    const local = src.fns.find((fn) => fn.name === name && !fn.method);
    if (local) return { src, fn: local };
    const imported = this.importedBinding(src, name);
    if (imported) {
      const fn = imported.src.fns.find((f) => f.name === imported.name && !f.method);
      if (fn) return { src: imported.src, fn };
    }
    return null;
  }

  /**
   * @param {Source} src @param {number} at @param {string} name @param {{ site: string, shell: boolean, env: Env, depth: number }} ctx
   * @returns {Resolution}
   */
  identifier(src, at, name, ctx) {
    const deeper = { ...ctx, depth: ctx.depth + 1 };
    const scopes = src.fns.filter((fn) => fn.bodyStart <= at && at < fn.bodyEnd).sort((a, b) => b.bodyStart - a.bodyStart);
    for (const fn of [...scopes, null]) {
      const from = fn ? fn.bodyStart : 0;
      const to = fn ? fn.bodyEnd : src.masked.length;
      const bindings = this.bindings(src, name, from, to, fn);
      if (bindings.length > 0) {
        const out = empty();
        for (const [bs, be] of bindings) merge(out, this.expr(src, bs, be, deeper));
        return out;
      }
      const index = fn ? fn.params.indexOf(name) : -1;
      if (fn && index >= 0) {
        const bound = ctx.env.get(fn);
        if (bound) {
          const arg = bound.args[index];
          if (!arg) return empty();
          return this.expr(bound.src, arg[0], arg[1], { ...deeper, site: bound.site, env: bound.env });
        }
        const out = empty();
        out.params.push({ src, fn, index });
        return out;
      }
    }
    const imported = this.importedBinding(src, name);
    if (imported) {
      const bindings = this.bindings(imported.src, imported.name, 0, imported.src.masked.length, null);
      const out = empty();
      for (const [bs, be] of bindings) merge(out, this.expr(imported.src, bs, be, deeper));
      if (bindings.length > 0) return out;
    }
    return dynamic(name);
  }

  /**
   * Right-hand sides assigned to `name` directly in [from, to): in `fn`'s own body, not in a nested function.
   * @param {Source} src @param {string} name @param {number} from @param {number} to @param {Fn | null} fn
   * @returns {[number, number][]}
   */
  bindings(src, name, from, to, fn) {
    const escaped = name.replace(/\$/g, "\\$");
    const re = src.py
      ? new RegExp(String.raw`^[ \t]*${escaped}[ \t]*(?::[^=\n]+)?=(?!=)`, "gm")
      : new RegExp(String.raw`(?:^|[;{}])[ \t]*(?:export\s+)?(?:(?:const|let|var)\s+)?${escaped}\s*(?::[^=\n]+)?=(?![=>])`, "gm");
    /** @type {[number, number][]} */
    const out = [];
    re.lastIndex = from;
    for (let m = re.exec(src.masked); m !== null && m.index < to; m = re.exec(src.masked)) {
      if (innermost(src.fns, m.index + m[0].length - 1) !== fn) continue;
      const start = m.index + m[0].length;
      out.push([start, expressionEnd(src, start)]);
    }
    return out;
  }

  /**
   * The module and exported name a local name is imported from, for relative imports.
   * @param {Source} src @param {string} name
   * @returns {{ src: Source, name: string } | null}
   */
  importedBinding(src, name) {
    for (const { specifier, names } of imports(src)) {
      const original = names.get(name);
      if (original === undefined) continue;
      const target = this.sources.get(specifier);
      if (target) return { src: target, name: original };
    }
    return null;
  }
}

/**
 * Relative imports: the repository path each resolves to and the local-to-exported name map.
 * @param {Source} src
 * @returns {{ specifier: string, names: Map<string, string> }[]}
 */
function imports(src) {
  const out = [];
  const dir = posix.dirname(src.path);
  if (src.py) {
    const re = /^[ \t]*from[ \t]+(\.+)([\w.]*)[ \t]+import[ \t]+\(?([^)\n]+)\)?/gm;
    for (let m = re.exec(src.text); m !== null; m = re.exec(src.text)) {
      let base = dir;
      for (let k = 1; k < m[1].length; k++) base = posix.dirname(base);
      const target = `${posix.join(base, ...m[2].split(".").filter(Boolean))}.py`;
      const names = new Map();
      for (const part of m[3].split(",")) {
        const alias = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (alias) names.set(alias[2] ?? alias[1], alias[1]);
      }
      out.push({ specifier: target, names });
    }
  } else {
    const re = /\bimport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g;
    for (let m = re.exec(src.text); m !== null; m = re.exec(src.text)) {
      const names = new Map();
      for (const part of m[1].split(",")) {
        const alias = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
        if (alias) names.set(alias[2] ?? alias[1], alias[1]);
      }
      out.push({ specifier: posix.normalize(posix.join(dir, m[2])), names });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Spawn sites.

const JS_SPAWNERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const PY_SUBPROCESS = new Set(["run", "Popen", "call", "check_call", "check_output", "getoutput", "getstatusoutput"]);

/**
 * @param {Source} src
 * @returns {{ at: number, open: number, fn: string }[]}
 */
function spawnCalls(src) {
  const { masked, text } = src;
  /** @type {{ at: number, open: number, fn: string }[]} */
  const calls = [];
  /** @param {RegExp} re @param {(m: RegExpExecArray) => string | null} which */
  const scan = (re, which) => {
    for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
      const fn = which(m);
      if (fn !== null) calls.push({ at: m.index, open: m.index + m[0].length - 1, fn });
    }
  };
  if (src.py) {
    /** @type {Map<string, string>} */
    const bare = new Map();
    const modules = new Map([["subprocess", "subprocess"], ["os", "os"], ["asyncio", "asyncio"]]);
    for (const m of text.matchAll(/^[ \t]*import[ \t]+(subprocess|os|asyncio)[ \t]+as[ \t]+(\w+)/gm)) modules.set(m[2], m[1]);
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(subprocess|os)[ \t]+import[ \t]+\(?([^)\n]+)/gm)) {
      for (const part of m[2].split(",")) {
        const alias = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (alias) bare.set(alias[2] ?? alias[1], `${m[1]}.${alias[1]}`);
      }
    }
    scan(/(?<![\w.])(\w+)\.(\w+)\s*\(/g, (m) => {
      const module = modules.get(m[1]);
      if (module === "subprocess" && PY_SUBPROCESS.has(m[2])) return `subprocess.${m[2]}`;
      if (module === "os" && /^(?:system|popen|exec\w+|spawn\w+|posix_spawnp?)$/.test(m[2])) return `os.${m[2]}`;
      if (module === "asyncio" && /^create_subprocess_(?:exec|shell)$/.test(m[2])) return `asyncio.${m[2]}`;
      return null;
    });
    scan(/(?<![\w.])(\w+)\s*\(/g, (m) => {
      const full = bare.get(m[1]);
      if (full === undefined) return null;
      const [module, fn] = full.split(".");
      if (module === "subprocess" && PY_SUBPROCESS.has(fn)) return full;
      if (module === "os" && /^(?:system|popen|exec\w+|spawn\w+|posix_spawnp?)$/.test(fn)) return full;
      return null;
    });
  } else {
    /** @type {Map<string, string>} */
    const bare = new Map();
    /** @type {Set<string>} */
    const namespaces = new Set();
    const from = String.raw`["'](?:node:)?child_process["']`;
    for (const m of text.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${from}`, "g"))) {
      for (const part of m[1].split(",")) {
        const alias = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
        if (alias && JS_SPAWNERS.has(alias[1])) bare.set(alias[2] ?? alias[1], alias[1]);
      }
    }
    for (const m of text.matchAll(new RegExp(String.raw`const\s*\{([^}]*)\}\s*=\s*require\(\s*${from}\s*\)`, "g"))) {
      for (const part of m[1].split(",")) {
        const alias = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/.exec(part);
        if (alias && JS_SPAWNERS.has(alias[1])) bare.set(alias[2] ?? alias[1], alias[1]);
      }
    }
    for (const m of text.matchAll(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s*${from}`, "g"))) namespaces.add(m[1]);
    for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*${from}\s*\)`, "g"))) namespaces.add(m[1]);
    scan(/(?<![\w$.])([\w$]+)\s*\(/g, (m) => bare.get(m[1]) ?? null);
    scan(/(?<![\w$.])([\w$]+)\s*\.\s*([\w$]+)\s*\(/g, (m) => {
      if (namespaces.has(m[1]) && JS_SPAWNERS.has(m[2])) return m[2];
      if (m[1] === "Bun" && (m[2] === "spawn" || m[2] === "spawnSync")) return `Bun.${m[2]}`;
      return null;
    });
  }
  return calls.sort((a, b) => a.at - b.at);
}

/**
 * The argument naming the command, and whether it is shell text.
 * @param {Source} src @param {{ open: number, fn: string }} call
 * @returns {{ range: [number, number] | null, shell: boolean, fixed?: string }}
 */
function commandArgument(src, call) {
  const { masked, text } = src;
  const close = closing(masked, call.open);
  const args = splitList(masked, call.open + 1, close < 0 ? masked.length : close);
  const argText = (/** @type {[number, number]} */ [s, e]) => text.slice(s, e);
  if (src.py) {
    const keyword = (/** @type {string} */ key) => args.find(([s]) => new RegExp(String.raw`^${key}\s*=(?!=)`).test(masked.slice(s)));
    const positional = args.filter(([s, e]) => !/^\w+\s*=(?!=)/.test(masked.slice(s, e)) && !masked.slice(s).startsWith("*"));
    const shellArg = keyword("shell");
    const shell = shellArg !== undefined && /=\s*True\b/.test(argText(shellArg));
    if (/^os\.(?:system|popen)$/.test(call.fn) || /getoutput|getstatusoutput|create_subprocess_shell/.test(call.fn)) {
      return { range: positional[0] ?? null, shell: true };
    }
    if (/^os\.spawn/.test(call.fn)) return { range: positional[1] ?? null, shell: false };
    const kw = keyword("args");
    if (kw) {
      const eq = masked.indexOf("=", kw[0]);
      return { range: trim(masked, eq + 1, kw[1]), shell };
    }
    return { range: positional[0] ?? null, shell };
  }
  if (call.fn === "fork") return { range: null, shell: false, fixed: "node" };
  const shell = call.fn === "exec" || call.fn === "execSync" || args.slice(1).some((range) => /\bshell\s*:\s*(?!false\b)[^\s,}]/.test(argText(range)));
  const first = args[0] ?? null;
  if (first && call.fn.startsWith("Bun.") && masked[first[0]] === "{") {
    const cmd = /\bcmd\s*:\s*/.exec(masked.slice(first[0], first[1]));
    if (cmd) {
      const start = first[0] + cmd.index + cmd[0].length;
      return { range: [start, expressionEnd(src, start)], shell: false };
    }
  }
  return { range: first, shell };
}

// ---------------------------------------------------------------------------------------------------------------

/** @typedef {{ file: string, expression: string, covers: string[], why: string }} Disposition */

/** @param {string} root @returns {Disposition[]} */
function readDispositions(root) {
  const path = join(root, ...DISPOSITIONS_FILE.split("/"));
  if (!existsSync(path)) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GateError(`${DISPOSITIONS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = data?.dynamic;
  const valid = Array.isArray(list) && list.every((item) =>
    typeof item?.file === "string" && typeof item?.expression === "string" && typeof item?.why === "string" &&
    item.why.trim() !== "" && !item.why.includes("\n") && Array.isArray(item?.covers) && item.covers.length > 0 &&
    item.covers.every((/** @type {unknown} */ phrase) => typeof phrase === "string" && phrase !== ""));
  if (!valid) throw new GateError(`${DISPOSITIONS_FILE}: "dynamic" must list { file, expression, covers: [phrases], why: one line }`);
  return list;
}

/** @param {string} security @param {string} name */
function mentioned(security, name) {
  const variants = new Set([name, name.replace(/\.(?:exe|cmd|bat|com)$/i, "")]);
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(String.raw`(?<![\w.-])${escaped}(?![\w-])`).test(security)) return true;
  }
  return false;
}

/** @param {string} expression */
function normalizeExpression(expression) {
  return expression.replace(/\s+/g, " ").trim();
}

runGate("disclosure-check", "node dev/disclosure-check.js [--root <dir>]", () => {
  const { root } = parseArgs(process.argv.slice(2));
  const securityPath = join(root, "SECURITY.md");
  if (!existsSync(securityPath)) throw new GateError("SECURITY.md does not exist");
  const security = readFileSync(securityPath, "utf8");
  const dispositions = readDispositions(root);

  /** @type {Map<string, Source>} */
  const sources = new Map();
  for (const path of repoFiles(root).filter((p) => SCANNED.test(p))) {
    const text = readTextFile(join(root, path));
    if (text === null) continue;
    const py = path.endsWith(".py");
    const { masked, literals } = py ? maskPy(text) : maskJs(text);
    /** @type {Source} */
    const src = { path, py, text, masked, literals, lineOf: lineIndex(text), fns: [] };
    src.fns = findFunctions(src);
    sources.set(path, src);
  }
  const resolver = new Resolver(sources);

  /** @type {Map<string, Set<string>>} */
  const commands = new Map();
  /** @type {{ file: string, line: number, expression: string, leaves: string[] }[]} */
  const dynamicSites = [];
  /** @type {Set<string>} */
  const expanded = new Set();
  let sites = 0;

  /** @param {Source} src @param {number} at @param {Resolution} resolution @param {string} expression */
  const record = (src, at, resolution, expression) => {
    for (const [name, where] of resolution.names) {
      const set = commands.get(name) ?? new Set();
      for (const site of where) set.add(site);
      commands.set(name, set);
    }
    if (resolution.dynamic.length > 0) {
      dynamicSites.push({ file: src.path, line: src.lineOf(at), expression: normalizeExpression(expression), leaves: resolution.dynamic });
    }
    for (const param of resolution.params) expandWrapper(param);
  };

  /** Every caller of a wrapper function, resolving the argument it passes for the command parameter. @param {ParamRef} ref */
  const expandWrapper = (ref) => {
    const { src, fn, index } = ref;
    const key = `${src.path}:${fn.start}:${index}`;
    if (expanded.has(key)) return;
    expanded.add(key);
    if (fn.name === null) {
      const at = fn.start;
      dynamicSites.push({
        file: src.path,
        line: src.lineOf(at),
        expression: normalizeExpression(fn.params[index] ?? "?"),
        leaves: [`parameter ${fn.params[index]} of an anonymous function`],
      });
      return;
    }
    const callers = [...sources.values()].filter((other) => other === src || imports(other).some((imp) => imp.specifier === src.path));
    const escaped = fn.name.replace(/\$/g, "\\$");
    const pattern = fn.method ? new RegExp(String.raw`\.\s*${escaped}\s*\(`, "g") : new RegExp(String.raw`(?<![\w$.])${escaped}\s*\(`, "g");
    for (const caller of callers) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(caller.masked); m !== null; m = pattern.exec(caller.masked)) {
        const open = m.index + m[0].length - 1;
        if (caller === src && fn.start <= m.index && m.index <= fn.bodyStart) continue;
        if (caller.fns.some((f) => f.start <= m.index && open < f.bodyStart && f.name === fn.name)) continue;
        const close = closing(caller.masked, open);
        const args = splitList(caller.masked, open + 1, close < 0 ? caller.masked.length : close);
        const arg = args[index];
        if (!arg) continue;
        const site = `${caller.path}:${caller.lineOf(m.index)}`;
        const resolution = resolver.expr(caller, arg[0], arg[1], { site, shell: false, env: new Map(), depth: 0 });
        // A method name is matched without its receiver's type, so a same-named method elsewhere (`db.run(sql)`)
        // is told apart by its argument: text that is not one command word cannot be a program to start.
        const names = [...resolution.names.keys()];
        const notCommands = names.length > 0 && names.every((name) => /\s/.test(name)) && resolution.dynamic.length === 0;
        if (fn.method && resolution.params.length === 0 && notCommands) continue;
        record(caller, m.index, resolution, caller.text.slice(arg[0], arg[1]));
      }
    }
  };

  for (const src of sources.values()) {
    for (const call of spawnCalls(src)) {
      sites++;
      const site = `${src.path}:${src.lineOf(call.at)}`;
      const { range, shell, fixed } = commandArgument(src, call);
      if (fixed) {
        record(src, call.at, named(fixed, site), fixed);
        continue;
      }
      if (range === null) {
        record(src, call.at, dynamic("no command argument"), call.fn);
        continue;
      }
      const resolution = resolver.expr(src, range[0], range[1], { site, shell, env: new Map(), depth: 0 });
      // Shell text is run by the platform's shell, itself a program the code starts.
      if (shell) merge(merge(resolution, named("sh", site)), named("cmd.exe", site));
      record(src, call.at, resolution, src.text.slice(range[0], range[1]));
    }
  }

  /** @type {string[]} */
  const findings = [];
  const lines = [`disclosure-check: ${sites} process-starting calls in core/ and hosts/; commands they can start:`];
  for (const name of [...commands.keys()].sort()) {
    const where = [...(/** @type {Set<string>} */ (commands.get(name)))].sort();
    const ok = mentioned(security, name);
    lines.push(`  ${ok ? "ok     " : "MISSING"} ${name}  (${where.join(", ")})`);
    if (!ok) findings.push(`disclosure-check: ${name} is not mentioned in SECURITY.md; started at ${where.join(", ")}`);
  }
  /** @type {Set<Disposition>} */
  const used = new Set();
  if (dynamicSites.length > 0) lines.push("dynamic sites (the command is not a name in the code):");
  const seen = new Set();
  for (const site of dynamicSites) {
    const id = `${site.file}:${site.line}:${site.expression}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const disposition = dispositions.find((d) => d.file === site.file && normalizeExpression(d.expression) === site.expression);
    if (!disposition) {
      lines.push(`  UNDISPOSED ${site.file}:${site.line} ${site.expression}`);
      findings.push(`disclosure-check: ${site.file}:${site.line}: the command ${JSON.stringify(site.expression)} cannot be named; add a disposition to ${DISPOSITIONS_FILE}`);
      continue;
    }
    used.add(disposition);
    const missing = disposition.covers.filter((phrase) => !security.includes(phrase));
    lines.push(`  ${missing.length === 0 ? "ok        " : "MISSING   "} ${site.file}:${site.line} ${site.expression}: ${disposition.why}`);
    for (const phrase of missing) {
      findings.push(`disclosure-check: ${site.file}:${site.line}: its disposition covers ${JSON.stringify(phrase)}, which SECURITY.md does not mention`);
    }
  }
  for (const disposition of dispositions) {
    if (!used.has(disposition)) lines.push(`  note: unused disposition ${disposition.file} ${JSON.stringify(disposition.expression)}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return report("disclosure-check", findings, "every command is disclosed in SECURITY.md", `${findings.length} undisclosed`);
});
