// @ts-check
// A strict subset of TOML 1.0: tables, dotted keys, basic and literal strings, decimal integers, floats, booleans,
// arrays and inline tables. Every other construct is refused by name with the file path and line, never guessed at.
// Integers are limited to the range a JS number holds exactly, so a value is never silently rounded.
import { fail } from "../errors.js";
import { normalizeLf, stripBom } from "../io.js";

/** @typedef {string | number | boolean | TomlArray | TomlTable} TomlValue */
/** @typedef {Array<TomlValue>} TomlArray */
/** @typedef {{ [key: string]: TomlValue }} TomlTable */

// How a table came to exist decides whether it may be extended later (TOML 1.0, "Table").
const IMPLICIT = 0; // created as an intermediate of a [header]; a later [header] may define it
const HEADER = 1; // defined by its own [header]; never again
const DOTTED = 2; // created by dotted keys; further dotted keys may extend it, a [header] may not define it
const INLINE = 3; // an inline table and everything inside it; frozen

const BARE_KEY = /[A-Za-z0-9_-]/;
const DEC_INT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/;
const FLOAT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;
const ESCAPES = /** @type {Record<string, string>} */ ({ b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" });

/**
 * Parses TOML text. `options.lines`, when given, receives the line of every header and key/value outside inline
 * tables, keyed by JSON.stringify of the key path, so schema errors can name a line.
 * @param {string} text
 * @param {string} path  the file the text came from, named in every error
 * @param {{ lines?: Map<string, number> }} [options]
 * @returns {TomlTable}
 */
export function parseToml(text, path, options = {}) {
  return new TomlParser(normalizeLf(stripBom(text)), path, options.lines).parse();
}

/** @param {TomlValue | undefined} value @returns {value is TomlTable} */
function isTable(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {TomlTable} table @param {string} key @param {TomlValue} value */
function setOwn(table, key, value) {
  // defineProperty keeps a key such as "__proto__" an ordinary own property.
  Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true });
}

/** @param {string[]} keys */
function render(keys) {
  return keys.map((key) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key))).join(".");
}

class TomlParser {
  /**
   * @param {string} source
   * @param {string} path
   * @param {Map<string, number> | undefined} lines
   */
  constructor(source, path, lines) {
    this.s = source;
    this.i = 0;
    this.line = 1;
    this.path = path;
    this.lines = lines;
    /** @type {WeakMap<TomlTable, number>} */
    this.kinds = new WeakMap();
  }

  /** @param {string} reason @param {number} [line] */
  error(reason, line = this.line) {
    return fail("E_PARSE_TOML", reason, { path: this.path, line });
  }

  /** @param {string} construct @param {number} [line] */
  refuse(construct, line = this.line) {
    return this.error(`${construct} is outside lampstand's TOML subset`, line);
  }

  describe() {
    if (this.i >= this.s.length) return "end of file";
    const c = this.s[this.i];
    if (c === "\n") return "end of line";
    if (c === "\r") return "a carriage return without a line feed";
    return JSON.stringify(c);
  }

  skipWs() {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }

  skipComment() {
    if (this.s[this.i] !== "#") return;
    for (this.i++; this.i < this.s.length && this.s[this.i] !== "\n"; this.i++) {
      const code = this.s.charCodeAt(this.i);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) throw this.error("control character in a comment");
    }
  }

  /** Whitespace, comments and newlines, as allowed between array elements and between top-level lines. */
  skipBlank() {
    for (;;) {
      this.skipWs();
      this.skipComment();
      if (this.s[this.i] !== "\n") return;
      this.i++;
      this.line++;
    }
  }

  /** After a header or key/value only whitespace and a comment may remain on the line. */
  expectEol() {
    this.skipWs();
    this.skipComment();
    if (this.i >= this.s.length) return;
    if (this.s[this.i] !== "\n") throw this.error(`expected end of line, found ${this.describe()}`);
    this.i++;
    this.line++;
  }

  parse() {
    /** @type {TomlTable} */
    const root = {};
    this.kinds.set(root, HEADER);
    let current = root;
    /** @type {string[]} */
    let currentPath = [];
    for (;;) {
      this.skipBlank();
      if (this.i >= this.s.length) return root;
      const line = this.line;
      if (this.s[this.i] === "[") {
        if (this.s[this.i + 1] === "[") throw this.refuse("array of tables ([[...]])");
        this.i++;
        this.skipWs();
        const keys = this.parseKey();
        this.skipWs();
        if (this.s[this.i] !== "]") throw this.error(`expected ] to close the table header, found ${this.describe()}`);
        this.i++;
        current = this.openHeader(root, keys, line);
        currentPath = keys;
        this.lines?.set(JSON.stringify(keys), line);
      } else {
        const keys = this.parseKeyValue(current, currentPath);
        this.lines?.set(JSON.stringify([...currentPath, ...keys]), line);
      }
      this.expectEol();
    }
  }

  /** @returns {string[]} */
  parseKey() {
    const keys = [this.parseSimpleKey()];
    for (;;) {
      this.skipWs();
      if (this.s[this.i] !== ".") return keys;
      this.i++;
      this.skipWs();
      keys.push(this.parseSimpleKey());
    }
  }

  parseSimpleKey() {
    const c = this.s[this.i];
    if (c === '"') return this.parseBasicString();
    if (c === "'") return this.parseLiteralString();
    const start = this.i;
    while (this.i < this.s.length && BARE_KEY.test(this.s[this.i])) this.i++;
    if (this.i === start) throw this.error(`expected a key, found ${this.describe()}`);
    return this.s.slice(start, this.i);
  }

  /**
   * Parses `key = value`, assigns it into `table` and returns the key path relative to `table`.
   * @param {TomlTable} table
   * @param {string[]} prefix  the key path of `table`, used in messages
   */
  parseKeyValue(table, prefix) {
    const line = this.line;
    const keys = this.parseKey();
    const full = [...prefix, ...keys];
    this.skipWs();
    if (this.s[this.i] !== "=") throw this.error(`expected = after key ${render(full)}, found ${this.describe()}`);
    this.i++;
    this.skipWs();
    const value = this.parseValue(full);
    this.assign(table, keys, value, line, prefix);
    return keys;
  }

  /**
   * @param {TomlTable} table
   * @param {string[]} keys
   * @param {TomlValue} value
   * @param {number} line
   * @param {string[]} prefix  the key path of `table`, used in messages
   */
  assign(table, keys, value, line, prefix) {
    let target = table;
    for (let k = 0; k < keys.length - 1; k++) {
      const key = keys[k];
      if (!Object.hasOwn(target, key)) {
        /** @type {TomlTable} */
        const created = {};
        this.kinds.set(created, DOTTED);
        setOwn(target, key, created);
        target = created;
        continue;
      }
      const existing = target[key];
      if (!isTable(existing) || this.kinds.get(existing) !== DOTTED) {
        throw this.error(`cannot add keys to ${render([...prefix, ...keys.slice(0, k + 1)])}: it is already defined`, line);
      }
      target = existing;
    }
    const last = keys[keys.length - 1];
    if (Object.hasOwn(target, last)) throw this.error(`duplicate key ${render([...prefix, ...keys])}`, line);
    setOwn(target, last, value);
  }

  /**
   * @param {TomlTable} root
   * @param {string[]} keys
   * @param {number} line
   */
  openHeader(root, keys, line) {
    let target = root;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const final = k === keys.length - 1;
      if (!Object.hasOwn(target, key)) {
        /** @type {TomlTable} */
        const created = {};
        this.kinds.set(created, final ? HEADER : IMPLICIT);
        setOwn(target, key, created);
        target = created;
        continue;
      }
      const existing = target[key];
      const name = render(keys.slice(0, k + 1));
      if (!isTable(existing)) throw this.error(`${name} is already defined as a value, not a table`, line);
      const kind = this.kinds.get(existing);
      if (kind === INLINE) throw this.error(`${name} is an inline table and cannot be extended`, line);
      if (final) {
        if (kind === HEADER) throw this.error(`table [${name}] is defined twice`, line);
        if (kind === DOTTED) throw this.error(`table [${name}] was already defined by dotted keys`, line);
        this.kinds.set(existing, HEADER);
      }
      target = existing;
    }
    return target;
  }

  /** @param {string[]} path  key path the value is assigned to, used in messages @returns {TomlValue} */
  parseValue(path) {
    const c = this.s[this.i];
    if (c === '"') return this.parseBasicString();
    if (c === "'") return this.parseLiteralString();
    if (c === "[") return this.parseArray(path);
    if (c === "{") return this.parseInlineTable(path);
    const start = this.i;
    while (this.i < this.s.length && !/[ \t\n\r,\]}#]/.test(this.s[this.i])) this.i++;
    if (this.i === start) throw this.error(`expected a value, found ${this.describe()}`);
    return this.scalar(this.s.slice(start, this.i));
  }

  /** @param {string} token */
  scalar(token) {
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^[+-]?(?:inf|nan)$/.test(token)) throw this.refuse("special float (inf, nan)");
    if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^\d{2}:\d{2}/.test(token)) throw this.refuse("date-time");
    if (/^[+-]?0x/.test(token)) throw this.refuse("hexadecimal integer");
    if (/^[+-]?0o/.test(token)) throw this.refuse("octal integer");
    if (/^[+-]?0b/.test(token)) throw this.refuse("binary integer");
    const digits = token.replaceAll("_", "");
    if (DEC_INT.test(token)) {
      const n = Number(digits);
      if (!Number.isSafeInteger(n)) throw this.error(`integer ${token} is outside the exactly representable range ±(2^53-1)`);
      return n === 0 ? 0 : n;
    }
    if (FLOAT.test(token) && /[.eE]/.test(token)) {
      const n = Number(digits);
      if (!Number.isFinite(n)) throw this.error(`float ${token} is out of range`);
      return n === 0 ? 0 : n;
    }
    if (/^[+-]?0[0-9_]/.test(token)) throw this.error(`leading zeros are not allowed in a number: ${token}`);
    throw this.error(`unrecognized value ${JSON.stringify(token)} (a string needs quotes)`);
  }

  parseBasicString() {
    const line = this.line;
    if (this.s.startsWith('"""', this.i)) throw this.refuse('multi-line basic string ("""...""")');
    let out = "";
    for (this.i++; ; ) {
      if (this.i >= this.s.length || this.s[this.i] === "\n") throw this.error("unterminated basic string", line);
      const c = this.s[this.i];
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\\") {
        const e = this.s[this.i + 1];
        if (e === "u" || e === "U") {
          const width = e === "u" ? 4 : 8;
          const hex = this.s.slice(this.i + 2, this.i + 2 + width);
          const code = /^[0-9A-Fa-f]+$/.test(hex) && hex.length === width ? Number.parseInt(hex, 16) : -1;
          if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
            throw this.error(`invalid unicode escape \\${e}${hex}`);
          }
          out += String.fromCodePoint(code);
          this.i += 2 + width;
          continue;
        }
        if (e === undefined || !Object.hasOwn(ESCAPES, e)) {
          throw this.error(`invalid escape ${e === undefined || e === "\n" ? "\\ at end of line" : `\\${e}`}`);
        }
        out += ESCAPES[e];
        this.i += 2;
        continue;
      }
      const code = this.s.charCodeAt(this.i);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) throw this.error("control character in a string");
      out += c;
      this.i++;
    }
  }

  parseLiteralString() {
    const line = this.line;
    if (this.s.startsWith("'''", this.i)) throw this.refuse("multi-line literal string ('''...''')");
    const start = ++this.i;
    for (;;) {
      if (this.i >= this.s.length || this.s[this.i] === "\n") throw this.error("unterminated literal string", line);
      if (this.s[this.i] === "'") break;
      const code = this.s.charCodeAt(this.i);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) throw this.error("control character in a string");
      this.i++;
    }
    return this.s.slice(start, this.i++);
  }

  /** @param {string[]} path */
  parseArray(path) {
    const line = this.line;
    /** @type {TomlValue[]} */
    const items = [];
    this.i++;
    for (;;) {
      this.skipBlank();
      if (this.i >= this.s.length) throw this.error("unterminated array", line);
      if (this.s[this.i] === "]") break;
      items.push(this.parseValue(path));
      this.skipBlank();
      if (this.s[this.i] === ",") {
        this.i++;
        continue;
      }
      if (this.s[this.i] === "]") break;
      if (this.i >= this.s.length) throw this.error("unterminated array", line);
      throw this.error(`expected , or ] in array, found ${this.describe()}`);
    }
    this.i++;
    return items;
  }

  /** @param {string[]} path */
  parseInlineTable(path) {
    /** @type {TomlTable} */
    const table = {};
    this.kinds.set(table, DOTTED);
    this.i++;
    this.skipWs();
    if (this.s[this.i] === "}") {
      this.i++;
      this.freeze(table);
      return table;
    }
    for (;;) {
      this.skipWs();
      if (this.s[this.i] === "\n") throw this.refuse("newline inside an inline table");
      this.parseKeyValue(table, path);
      this.skipWs();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
        this.skipWs();
        if (this.s[this.i] === "}") throw this.error("trailing comma in an inline table");
        continue;
      }
      if (c === "}") break;
      if (c === "\n") throw this.refuse("newline inside an inline table");
      throw this.error(`expected , or } in inline table, found ${this.describe()}`);
    }
    this.i++;
    this.freeze(table);
    return table;
  }

  /** Marks an inline table and every table inside it as closed to headers and dotted keys. @param {TomlValue} value */
  freeze(value) {
    if (Array.isArray(value)) {
      for (const item of value) this.freeze(item);
    } else if (isTable(value)) {
      this.kinds.set(value, INLINE);
      for (const item of Object.values(value)) this.freeze(item);
    }
  }
}

/** A TOML basic string. JSON's escapes are TOML's, apart from DEL, which TOML wants escaped. @param {string} text */
export function tomlString(text) {
  return JSON.stringify(text).replaceAll("\x7f", "\\u007F");
}
