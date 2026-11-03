// @ts-check
// Five-field cron strings (minute hour day-of-month month day-of-week), evaluated in local time. Each field takes
// `*`, numbers, ranges `a-b` and steps `/n`, joined by commas; names (JAN, MON) and macros (@daily) are refused
// rather than guessed at. As in classic cron, when both day fields are restricted a day matching either one fires.

/** @typedef {{ minute: Set<number>, hour: Set<number>, dom: Set<number>, month: Set<number>, dow: Set<number>, domAny: boolean, dowAny: boolean }} Cron */

const FIELDS = /** @type {const} */ ([
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
]);

/**
 * @param {string} text
 * @returns {Cron}
 * @throws {Error} naming the field that is malformed
 */
export function parseCron(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron string has 5 fields (minute hour day-of-month month day-of-week), found ${parts.length}`);
  const sets = parts.map((part, k) => parseField(part, FIELDS[k][0], FIELDS[k][1], FIELDS[k][2]));
  const dow = new Set([...sets[4]].map((day) => (day === 7 ? 0 : day)));
  const cron = {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    domAny: parts[2].startsWith("*"),
    dowAny: parts[4].startsWith("*"),
  };
  if (nextOccurrence(cron, new Date(2000, 0, 1)) === null) throw new Error(`cron string ${JSON.stringify(text)} never fires`);
  return cron;
}

/**
 * @param {string} part
 * @param {string} name
 * @param {number} min
 * @param {number} max
 */
function parseField(part, name, min, max) {
  /** @type {Set<number>} */
  const values = new Set();
  for (const item of part.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new Error(`cron ${name} field ${JSON.stringify(part)} is not numbers, ranges, steps or *`);
    const [, whole, from, to, step] = match;
    const low = whole === "*" ? min : Number(from);
    const high = whole === "*" ? max : to !== undefined ? Number(to) : step !== undefined ? max : low;
    const by = step === undefined ? 1 : Number(step);
    if (low < min || high > max || low > high || by < 1) {
      throw new Error(`cron ${name} field ${JSON.stringify(part)} is outside ${min}-${max}`);
    }
    for (let value = low; value <= high; value += by) values.add(value);
  }
  return values;
}

/** @param {Cron} cron @param {Date} date */
function dayMatches(cron, date) {
  const dom = cron.dom.has(date.getDate());
  const dow = cron.dow.has(date.getDay());
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dow;
  if (cron.dowAny) return dom;
  return dom || dow;
}

/**
 * The first whole minute strictly after `after` at which `cron` fires, or null when none falls within eight years
 * (enough to cover a February 29th schedule).
 * @param {Cron} cron
 * @param {Date} after
 * @returns {Date | null}
 */
export function nextOccurrence(cron, after) {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = new Date(after.getTime());
  limit.setFullYear(limit.getFullYear() + 8);
  while (d <= limit) {
    if (!cron.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(cron, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!cron.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!cron.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      return d;
    }
  }
  return null;
}
