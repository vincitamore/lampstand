// @ts-check
// A strict subset of YAML 1.2 for Markdown frontmatter: block mappings, block sequences, literal and folded block
// scalars (with a chomping indicator), flow sequences and flow mappings (on one line or across indented lines),
// single-line plain, single-quoted and double-quoted scalars, and the core-schema null, boolean, integer and float.
// Dates and timestamps stay strings. Every other construct (anchors, aliases, tags, directives, document markers,
// complex keys, block scalar indentation indicators, multi-line plain and quoted scalars) is refused by name with
// the path and line. Mapping keys are always strings. Plain scalars that YAML 1.1 readers turn into booleans or
// octals (yes, no, on, off, 0755) are refused as ambiguous rather than read one way, since other loaders of the same
// file disagree.
import { fail } from "../errors.js";

/** @typedef {null | boolean | number | string | YamlArray | YamlMap} YamlValue */
/** @typedef {Array<YamlValue>} YamlArray */
/** @typedef {{ [key: string]: YamlValue }} YamlMap */
/**
 * @typedef {{ indent: number, text: string, line: number, k: number, fault?: string }} Line
 *   `k` indexes the raw line; `fault` is an error that holds only if the line is read as structure (a tab after the
 *   indentation is content inside a block scalar).
 */
/**
 * @typedef {{ src: string, i: number, starts: number[], lines: number[], next: number, indent: number, open: number }} Flow
 *   A flow collection's text across the lines read so far (joined by "\n"); `starts[j]` is where file line
 *   `lines[j]` begins in `src`; `next` is the raw index of the next line to read; continuation lines must be indented
 *   past `indent`; `open` is the line the collection opens on.
 */

const INT = /^[-+]?[0-9]+$/;
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const NULLS = new Set(["~", "null", "Null", "NULL"]);
const TRUES = new Set(["true", "True", "TRUE"]);
const FALSES = new Set(["false", "False", "FALSE"]);
const AMBIGUOUS = new Set(["yes", "Yes", "YES", "no", "No", "NO", "on", "On", "ON", "off", "Off", "OFF"]);
const ESCAPES = /** @type {Record<string, string>} */ ({
  0: "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
});
const HEX_ESCAPES = /** @type {Record<string, number>} */ ({ x: 2, u: 4, U: 8 });

/**
 * Parses YAML text whose first line is line `firstLine` of `path`. Returns a mapping, or `{}` for an empty text.
 * @param {string} text  LF-normalized
 * @param {string} path
 * @param {number} [firstLine]
 * @returns {YamlMap}
 */
export function parseYamlMapping(text, path, firstLine = 1) {
  const parser = new YamlParser(path);
  const lines = parser.scan(text, firstLine);
  if (lines.length === 0) return {};
  const first = lines[0];
  if (first.fault) throw parser.error(first.fault, first.line);
  if (first.indent !== 0) throw parser.error("the top level must start at column 1", first.line);
  if (isSeqItem(first.text)) throw parser.error("the top level must be a mapping, not a sequence", first.line);
  parser.lines = lines;
  const value = parser.parseMapping(0);
  if (parser.at < lines.length) throw parser.error("unexpected indentation", lines[parser.at].line);
  return value;
}

/** @param {string} text */
function isSeqItem(text) {
  return text === "-" || text.startsWith("- ") || text.startsWith("-\t");
}

/** @param {YamlMap} map @param {string} key @param {YamlValue} value */
function setOwn(map, key, value) {
  // defineProperty keeps a key such as "__proto__" an ordinary own property.
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

class YamlParser {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
    /** @type {Line[]} */
    this.lines = [];
    this.at = 0;
    /** @type {string[]} every line of the text, for block scalars and flow collections that read past one line */
    this.raw = [];
    this.firstLine = 1;
  }

  /** @param {string} reason @param {number} line */
  error(reason, line) {
    return fail("E_PARSE_FRONTMATTER", reason, { path: this.path, line });
  }

  /** @param {string} construct @param {number} line */
  refuse(construct, line) {
    return this.error(`${construct} is outside lampstand's frontmatter YAML subset`, line);
  }

  /**
   * Splits text into significant lines, dropping blank and comment-only lines, and refuses what is wrong on any
   * line regardless of position: control characters, directives and document markers. A tab in the indentation is
   * refused when the line is read as structure.
   * @param {string} text
   * @param {number} firstLine
   * @returns {Line[]}
   */
  scan(text, firstLine) {
    /** @type {Line[]} */
    const out = [];
    const raw = text.split("\n");
    if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
    this.raw = raw;
    this.firstLine = firstLine;
    for (let k = 0; k < raw.length; k++) {
      const line = firstLine + k;
      const source = raw[k];
      for (let c = 0; c < source.length; c++) {
        const code = source.charCodeAt(c);
        if ((code < 0x20 && code !== 0x09) || code === 0x7f || code === 0xfeff) {
          throw this.error(`control character U+${code.toString(16).toUpperCase().padStart(4, "0")}`, line);
        }
      }
      let indent = 0;
      while (source[indent] === " ") indent++;
      const text = source.slice(indent).replace(/[ \t]+$/, "");
      if (text === "" || text.startsWith("#")) continue;
      if (indent === 0 && text.startsWith("%")) throw this.refuse("directive (%...)", line);
      if (indent === 0 && /^(?:---|\.\.\.)(?:[ \t]|$)/.test(text)) {
        throw this.refuse("document marker (multiple documents)", line);
      }
      /** @type {Line} */
      const entry = { indent, text, line, k };
      if (source[indent] === "\t") entry.fault = "tab character in indentation";
      out.push(entry);
    }
    return out;
  }

  /** @returns {Line | undefined} */
  peek() {
    const head = this.lines[this.at];
    if (head?.fault) throw this.error(head.fault, head.line);
    return head;
  }

  /** Moves past every significant line at or before raw line `k`, which a multi-line value has consumed. @param {number} k */
  skipTo(k) {
    while (this.at < this.lines.length && this.lines[this.at].k <= k) this.at++;
  }

  /** @param {number} indent */
  parseBlock(indent) {
    const head = /** @type {Line} */ (this.peek());
    return isSeqItem(head.text) ? this.parseSequence(indent) : this.parseMapping(indent);
  }

  /** @param {number} indent @returns {YamlMap} */
  parseMapping(indent) {
    /** @type {YamlMap} */
    const map = {};
    for (let head = this.peek(); head && head.indent === indent; head = this.peek()) {
      if (isSeqItem(head.text)) throw this.error("expected a mapping key, found a sequence item", head.line);
      const { key, rest } = this.splitKey(head);
      if (Object.hasOwn(map, key)) throw this.error(`duplicate key ${JSON.stringify(key)}`, head.line);
      this.at++;
      setOwn(map, key, this.parseValueAfterIndicator(rest, head, indent, true));
    }
    const next = this.peek();
    if (next && next.indent > indent) throw this.error("unexpected indentation", next.line);
    return map;
  }

  /** @param {number} indent @returns {YamlArray} */
  parseSequence(indent) {
    /** @type {YamlArray} */
    const items = [];
    for (let head = this.peek(); head && head.indent === indent && isSeqItem(head.text); head = this.peek()) {
      const afterDash = head.text.slice(1);
      const gap = afterDash.length - afterDash.replace(/^[ \t]+/, "").length;
      const rest = afterDash.slice(gap);
      if (rest !== "" && !rest.startsWith("#") && (isSeqItem(rest) || this.looksLikeKey(rest))) {
        // A compact nested node ("- key: v" or "- - v"): re-read the remainder as a line at its own column.
        const column = indent + 1 + gap;
        this.lines[this.at] = { indent: column, text: rest, line: head.line, k: head.k };
        items.push(this.parseBlock(column));
        continue;
      }
      this.at++;
      items.push(this.parseValueAfterIndicator(rest, head, indent, false));
    }
    const next = this.peek();
    if (next && next.indent > indent) throw this.error("unexpected indentation", next.line);
    return items;
  }

  /**
   * The value after `key:` or `- `: a block scalar, inline on the same line, or a nested block on the following lines.
   * @param {string} rest
   * @param {Line} head
   * @param {number} indent  indentation of the mapping or sequence that holds the value
   * @param {boolean} inMapping  a sequence may sit at the same indentation as its mapping key
   * @returns {YamlValue}
   */
  parseValueAfterIndicator(rest, head, indent, inMapping) {
    if (rest[0] === "|" || rest[0] === ">") return this.parseBlockScalar(rest, head, indent);
    if (rest === "" || rest.startsWith("#")) {
      const next = this.peek();
      if (next && next.indent > indent) return this.parseBlock(next.indent);
      if (inMapping && next && next.indent === indent && isSeqItem(next.text)) return this.parseSequence(indent);
      return null;
    }
    const { value, plain } = this.parseInline(rest, head, indent);
    const next = this.peek();
    if (next && next.indent > indent) {
      throw plain
        ? this.refuse("multi-line plain scalar", next.line)
        : this.error("unexpected indentation after a value", next.line);
    }
    return value;
  }

  /**
   * A literal (|) or folded (>) block scalar whose header is `header` on `head`'s line. Its content is the lines
   * that follow, indented past `indent`, at the indentation of the first non-empty one; a chomping indicator (- strip,
   * + keep, none clip) decides the final line breaks.
   * @param {string} header
   * @param {Line} head
   * @param {number} indent
   * @returns {string}
   */
  parseBlockScalar(header, head, indent) {
    if (/^[|>](?:[-+]?[0-9]|[0-9][-+]?)/.test(header)) throw this.refuse("block scalar indentation indicator", head.line);
    const match = /^([|>])([-+]?)(?:[ \t]+#.*|[ \t]*)$/.exec(header);
    if (!match) throw this.error(`unexpected text after a block scalar header: ${JSON.stringify(header)}`, head.line);
    /** @type {string[]} content lines with the content indentation removed; "" for an empty line */
    const body = [];
    let content = 0;
    let leading = 0;
    let last = head.k;
    for (let k = head.k + 1; k < this.raw.length; k++) {
      const source = this.raw[k];
      let spaces = 0;
      while (source[spaces] === " ") spaces++;
      if (spaces === source.length) {
        // Spaces past the content indentation are content; fewer make an empty line.
        if (content === 0) leading = Math.max(leading, spaces);
        body.push(content > 0 && spaces > content ? source.slice(content) : "");
        continue;
      }
      if (spaces <= indent || (content > 0 && spaces < content)) break;
      if (content === 0) {
        content = spaces;
        if (leading > content) throw this.error("a leading empty line of a block scalar is indented past its first text line", this.firstLine + k);
      }
      body.push(source.slice(content));
      last = k;
    }
    this.skipTo(last);
    let end = body.length;
    while (end > 0 && body[end - 1] === "") end--;
    const trailing = body.length - end;
    const chomp = match[2];
    if (end === 0) return chomp === "+" ? "\n".repeat(trailing) : "";
    const lines = body.slice(0, end);
    const text = match[1] === "|" ? lines.join("\n") : fold(lines);
    if (chomp === "-") return text;
    return chomp === "+" ? `${text}\n${"\n".repeat(trailing)}` : `${text}\n`;
  }

  /**
   * True when `text` starts with a mapping key followed by `:` and whitespace or end of line.
   * @param {string} text
   */
  looksLikeKey(text) {
    const c = text[0];
    if (c === '"' || c === "'") {
      const end = c === '"' ? scanDoubleQuoted(text) : scanSingleQuoted(text);
      return end > 0 && /^[ \t]*:(?:[ \t]|$)/.test(text.slice(end));
    }
    if ("[{&*!|>%@`?".includes(c)) return false;
    return findMappingColon(text) >= 0;
  }

  /** @param {Line} head @returns {{ key: string, rest: string }} */
  splitKey(head) {
    const { text, line } = head;
    const c = text[0];
    if (c === "?" && (text.length === 1 || text[1] === " " || text[1] === "\t")) throw this.refuse("complex key (? ...)", line);
    if (c === "[" || c === "{") throw this.refuse("complex key (a flow collection as a key)", line);
    this.refuseIndicator(text, line);
    if (c === '"' || c === "'") {
      const end = c === '"' ? scanDoubleQuoted(text) : scanSingleQuoted(text);
      if (end < 0) throw this.refuse("multi-line quoted scalar", line);
      const after = text.slice(end);
      const colon = /^[ \t]*:(?:[ \t]+|$)/.exec(after);
      if (!colon) throw this.error("expected : after a quoted key", line);
      const key = c === '"' ? this.decodeDouble(text.slice(1, end - 1), line) : text.slice(1, end - 1).replaceAll("''", "'");
      return { key, rest: after.slice(colon[0].length) };
    }
    const colon = findMappingColon(text);
    if (colon < 0) {
      throw this.error(`expected a mapping entry "key: value", found ${JSON.stringify(text)}`, line);
    }
    const key = text.slice(0, colon).replace(/[ \t]+$/, "");
    if (key === "") throw this.error("empty mapping key", line);
    return { key, rest: text.slice(colon + 1).replace(/^[ \t]+/, "") };
  }

  /** Refuses node properties and indicators that begin a construct outside the subset. @param {string} text @param {number} line */
  refuseIndicator(text, line) {
    switch (text[0]) {
      case "&":
        throw this.refuse("anchor (&)", line);
      case "*":
        throw this.refuse("alias (*)", line);
      case "!":
        throw this.refuse("tag (!)", line);
      case "|":
      case ">":
        throw this.error(`a block scalar (${text[0]}) can only be the whole value after "key:" or "-"`, line);
      case "%":
        throw this.refuse("directive (%)", line);
      case "@":
      case "`":
        throw this.error(`reserved indicator ${text[0]} cannot start a plain scalar`, line);
    }
  }

  /**
   * One inline value: a flow collection, a quoted scalar or a plain scalar, then only a comment.
   * @param {string} text
   * @param {Line} head
   * @param {number} indent  indentation of the mapping or sequence that holds the value
   * @returns {{ value: YamlValue, plain: boolean }}
   */
  parseInline(text, head, indent) {
    const line = head.line;
    const c = text[0];
    if (c === "[" || c === "{") return { value: this.parseFlow(text, head, indent), plain: false };
    this.refuseIndicator(text, line);
    if (c === "?" && (text.length === 1 || text[1] === " " || text[1] === "\t")) throw this.refuse("complex key (? ...)", line);
    if (isSeqItem(text)) throw this.error("a sequence cannot start on the same line as its key", line);
    if (c === "," || c === "]" || c === "}") throw this.error(`indicator ${c} cannot start a plain scalar`, line);
    if (c === '"' || c === "'") {
      const end = c === '"' ? scanDoubleQuoted(text) : scanSingleQuoted(text);
      if (end < 0) throw this.refuse("multi-line quoted scalar", line);
      const inner = text.slice(1, end - 1);
      const value = c === '"' ? this.decodeDouble(inner, line) : inner.replaceAll("''", "'");
      this.expectTrailingComment(text.slice(end), line);
      return { value, plain: false };
    }
    const comment = text.search(/[ \t]#/);
    const plain = (comment < 0 ? text : text.slice(0, comment)).replace(/[ \t]+$/, "");
    if (findMappingColon(plain) >= 0) throw this.error("a mapping cannot start on the same line as its key", line);
    return { value: this.resolvePlain(plain, line), plain: true };
  }

  /** @param {string} rest @param {number} line */
  expectTrailingComment(rest, line) {
    if (rest === "" || /^[ \t]+#/.test(rest) || /^[ \t]+$/.test(rest)) return;
    throw this.error(`unexpected text after a value: ${JSON.stringify(rest.trim())}`, line);
  }

  /**
   * A flow collection that opens `text`, the value on `head`'s line, read across continuation lines (each indented
   * past `indent`) until it closes; then only a comment may follow on the closing line.
   * @param {string} text
   * @param {Line} head
   * @param {number} indent
   * @returns {YamlValue}
   */
  parseFlow(text, head, indent) {
    /** @type {Flow} */
    const f = { src: text, i: 0, starts: [0], lines: [head.line], next: head.k + 1, indent, open: head.line };
    const value = f.src[0] === "[" ? this.flowSequence(f) : this.flowMapping(f);
    this.expectTrailingComment(f.src.slice(f.i), this.flowLine(f, f.i));
    this.skipTo(f.next - 1);
    return value;
  }

  /** The file line of position `pos` in a flow's text. @param {Flow} f @param {number} pos */
  flowLine(f, pos) {
    let j = f.starts.length - 1;
    while (j > 0 && f.starts[j] > pos) j--;
    return f.lines[j];
  }

  /** Appends the next raw line to a flow's text; false when the text has no more lines. @param {Flow} f */
  flowMore(f) {
    if (f.next >= this.raw.length) return false;
    const source = this.raw[f.next];
    const line = this.firstLine + f.next;
    let spaces = 0;
    while (source[spaces] === " ") spaces++;
    const rest = source.slice(spaces);
    if (rest.trim() !== "" && spaces <= f.indent) {
      throw this.error(`the flow collection opened on line ${f.open} is not closed before this line, which is not indented past its key`, line);
    }
    f.src += "\n";
    f.starts.push(f.src.length);
    f.lines.push(line);
    f.src += rest;
    f.next++;
    return true;
  }

  /** Skips blanks, line breaks and comments inside a flow collection, reading further lines as needed. @param {Flow} f */
  flowSpace(f) {
    for (;;) {
      const c = f.src[f.i];
      if (c === " " || c === "\t" || c === "\n") {
        f.i++;
      } else if (c === "#" && /[ \t\n]/.test(f.src[f.i - 1] ?? "")) {
        const eol = f.src.indexOf("\n", f.i);
        f.i = eol < 0 ? f.src.length : eol;
      } else if (c === undefined) {
        if (!this.flowMore(f)) throw this.error("the flow collection opened on this line is never closed", f.open);
      } else {
        return;
      }
    }
  }

  /**
   * One node inside a flow collection. `plainEnd` is where a plain scalar ended (-1 for any other node), so a caller
   * that finds more text after a line break can name a multi-line plain scalar.
   * @param {Flow} f
   * @returns {{ value: YamlValue, plainEnd: number }}
   */
  flowNode(f) {
    this.flowSpace(f);
    const c = f.src[f.i];
    if (c === "[") return { value: this.flowSequence(f), plainEnd: -1 };
    if (c === "{") return { value: this.flowMapping(f), plainEnd: -1 };
    if (c === '"' || c === "'") return { value: this.flowQuoted(f), plainEnd: -1 };
    const line = this.flowLine(f, f.i);
    return { value: this.resolvePlain(this.flowPlain(f), line), plainEnd: f.i };
  }

  /** A quoted scalar inside a flow collection; it must close on its own line. @param {Flow} f @returns {string} */
  flowQuoted(f) {
    const line = this.flowLine(f, f.i);
    const eol = f.src.indexOf("\n", f.i);
    const tail = f.src.slice(f.i, eol < 0 ? f.src.length : eol);
    const quote = tail[0];
    const end = quote === '"' ? scanDoubleQuoted(tail) : scanSingleQuoted(tail);
    if (end < 0) throw this.refuse("multi-line quoted scalar", line);
    f.i += end;
    const inner = tail.slice(1, end - 1);
    return quote === '"' ? this.decodeDouble(inner, line) : inner.replaceAll("''", "'");
  }

  /**
   * The text of a plain scalar inside a flow collection: it ends at a line break, a flow indicator, a comment, or a
   * `:` followed by a blank or an indicator.
   * @param {Flow} f
   */
  flowPlain(f) {
    const line = this.flowLine(f, f.i);
    const rest = f.src.slice(f.i);
    this.refuseIndicator(rest, line);
    if (/^\?(?:[ \t\n]|$)/.test(rest)) throw this.refuse("complex key (? ...)", line);
    if (/^-(?:[ \t\n,[\]{}]|$)/.test(rest)) throw this.error("a block sequence cannot appear inside a flow collection", line);
    if (rest[0] === "#") throw this.error("a plain scalar cannot start with #", line);
    const begin = f.i;
    while (f.i < f.src.length) {
      const c = f.src[f.i];
      if (c === "\n" || ",[]{}".includes(c)) break;
      if (c === "#" && /[ \t]/.test(f.src[f.i - 1])) break;
      if (c === ":" && /^(?:[ \t\n,[\]{}]|$)/.test(f.src[f.i + 1] ?? "")) break;
      f.i++;
    }
    const text = f.src.slice(begin, f.i).replace(/[ \t]+$/, "");
    if (text === "") throw this.error(`unexpected ${JSON.stringify(f.src[f.i] ?? "end of text")} in a flow collection`, line);
    return text;
  }

  /**
   * The error for text where a flow collection expected `expected`: a plain scalar continued on the next line is
   * named as such, since YAML would fold it into one value.
   * @param {Flow} f @param {number} plainEnd @param {string} what @param {string} expected
   */
  flowUnexpected(f, plainEnd, what, expected) {
    if (plainEnd >= 0 && f.src.slice(plainEnd, f.i).includes("\n")) return this.refuse("multi-line plain scalar", this.flowLine(f, f.i));
    return this.error(`expected ${expected} in ${what}, found ${JSON.stringify(f.src[f.i])}`, this.flowLine(f, f.i));
  }

  /** A flow sequence; `f.i` is at its "[". @param {Flow} f @returns {YamlArray} */
  flowSequence(f) {
    f.i++;
    /** @type {YamlArray} */
    const items = [];
    for (;;) {
      this.flowSpace(f);
      if (f.src[f.i] === "]") {
        f.i++;
        return items;
      }
      if (f.src[f.i] === ",") throw this.error("empty entry in a flow sequence", this.flowLine(f, f.i));
      const { value, plainEnd } = this.flowNode(f);
      items.push(value);
      this.flowSpace(f);
      const c = f.src[f.i];
      if (c === ":") throw this.refuse("mapping inside a flow sequence", this.flowLine(f, f.i));
      f.i++;
      if (c === ",") continue;
      if (c === "]") return items;
      f.i--;
      throw this.flowUnexpected(f, plainEnd, "a flow sequence", ", or ]");
    }
  }

  /** A flow mapping; `f.i` is at its "{". Keys are strings, as in a block mapping. @param {Flow} f @returns {YamlMap} */
  flowMapping(f) {
    f.i++;
    /** @type {YamlMap} */
    const map = {};
    for (;;) {
      this.flowSpace(f);
      const line = this.flowLine(f, f.i);
      const c = f.src[f.i];
      if (c === "}") {
        f.i++;
        return map;
      }
      if (c === ",") throw this.error("empty entry in a flow mapping", line);
      if (c === "[" || c === "{") throw this.refuse("complex key (a flow collection as a key)", line);
      const quoted = c === '"' || c === "'";
      const key = quoted ? this.flowQuoted(f) : this.flowPlain(f);
      const keyEnd = f.i;
      this.flowSpace(f);
      if (f.src[f.i] !== ":") {
        if (f.src[f.i] === "," || f.src[f.i] === "}") throw this.refuse("flow mapping key without a value (key: value)", line);
        throw this.flowUnexpected(f, quoted ? -1 : keyEnd, "a flow mapping", ":");
      }
      if (f.src.slice(keyEnd, f.i).includes("\n")) throw this.error("a flow mapping key and its : must be on one line", line);
      f.i++;
      if (Object.hasOwn(map, key)) throw this.error(`duplicate key ${JSON.stringify(key)}`, line);
      this.flowSpace(f);
      let value = /** @type {YamlValue} */ (null);
      let plainEnd = -1;
      if (f.src[f.i] !== "," && f.src[f.i] !== "}") ({ value, plainEnd } = this.flowNode(f));
      setOwn(map, key, value);
      this.flowSpace(f);
      const next = f.src[f.i];
      f.i++;
      if (next === ",") continue;
      if (next === "}") return map;
      f.i--;
      throw this.flowUnexpected(f, plainEnd, "a flow mapping", ", or }");
    }
  }

  /** @param {string} text @param {number} line @returns {YamlValue} */
  resolvePlain(text, line) {
    if (text === "" || NULLS.has(text)) return null;
    if (TRUES.has(text)) return true;
    if (FALSES.has(text)) return false;
    if (AMBIGUOUS.has(text)) {
      throw this.error(`ambiguous plain scalar ${text} (a YAML 1.1 boolean); quote it to mean the string`, line);
    }
    if (/^[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN)$/.test(text)) throw this.refuse("special float (.inf, .nan)", line);
    if (/^[-+]?0[xo]/.test(text)) throw this.refuse("hexadecimal or octal integer", line);
    if (INT.test(text)) {
      if (/^[-+]?0[0-9]/.test(text)) {
        throw this.error(`ambiguous integer ${text} with a leading zero (octal in YAML 1.1); quote it or drop the zero`, line);
      }
      const n = Number(text);
      if (!Number.isSafeInteger(n)) throw this.error(`integer ${text} is outside the exactly representable range ±(2^53-1)`, line);
      return n === 0 ? 0 : n;
    }
    if (FLOAT.test(text)) {
      const n = Number(text.endsWith(".") ? text.slice(0, -1) : text.replace(/^([-+]?)\./, "$10."));
      if (!Number.isFinite(n)) throw this.error(`float ${text} is out of range`, line);
      return n === 0 ? 0 : n;
    }
    return text;
  }

  /** @param {string} inner  the text between the quotes @param {number} line */
  decodeDouble(inner, line) {
    let out = "";
    for (let i = 0; i < inner.length; ) {
      const c = inner[i];
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const e = inner[i + 1];
      if (e !== undefined && Object.hasOwn(HEX_ESCAPES, e)) {
        const width = HEX_ESCAPES[e];
        const hex = inner.slice(i + 2, i + 2 + width);
        const code = hex.length === width && /^[0-9A-Fa-f]+$/.test(hex) ? Number.parseInt(hex, 16) : -1;
        if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
          throw this.error(`invalid escape \\${e}${hex}`, line);
        }
        out += String.fromCodePoint(code);
        i += 2 + width;
        continue;
      }
      if (e === undefined || !Object.hasOwn(ESCAPES, e)) throw this.error(`invalid escape \\${e ?? ""}`, line);
      out += ESCAPES[e];
      i += 2;
    }
    return out;
  }
}

/** Index just past the closing quote of a double-quoted scalar starting at 0, or -1 if it does not close. @param {string} text */
function scanDoubleQuoted(text) {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

/**
 * Folds a folded block scalar's lines: a line break between two text lines becomes a space, and n empty lines
 * between them become n breaks; lines that start with a blank ("more indented") keep their breaks.
 * @param {string[]} lines  content lines, "" for an empty line, the last one not empty
 */
function fold(lines) {
  let out = "";
  let previous = "";
  let empty = 0;
  for (const line of lines) {
    if (line === "") {
      empty++;
      continue;
    }
    const more = line[0] === " " || line[0] === "\t";
    if (previous === "") out += "\n".repeat(empty);
    else if (previous === "text" && !more) out += empty === 0 ? " " : "\n".repeat(empty);
    else out += "\n".repeat(empty + 1);
    out += line;
    previous = more ? "more" : "text";
    empty = 0;
  }
  return out;
}

/** Index just past the closing quote of a single-quoted scalar starting at 0, or -1. @param {string} text */
function scanSingleQuoted(text) {
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== "'") continue;
    if (text[i + 1] === "'") i++;
    else return i + 1;
  }
  return -1;
}

/**
 * Index of the `:` that ends a plain mapping key (followed by whitespace or end of line, before any comment), or -1.
 * @param {string} text
 */
function findMappingColon(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "#" && i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) return -1;
    if (text[i] === ":" && (i + 1 === text.length || text[i + 1] === " " || text[i + 1] === "\t")) return i;
  }
  return -1;
}
