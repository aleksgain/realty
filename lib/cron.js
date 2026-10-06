'use strict';
// Minimal 5-field cron matcher (minute hour day-of-month month day-of-week), evaluated in a given IANA time zone.
// Supports *, lists (1,2), ranges (1-5), steps (*/15, 1-30/5). Day-of-week 0 or 7 = Sunday.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(src, [lo, hi]) {
  const set = new Set();
  for (const part of src.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let a, b;
    if (range === '*') [a, b] = [lo, hi];
    else if (range.includes('-')) [a, b] = range.split('-').map(Number);
    else { a = Number(range); b = stepStr ? hi : a; }
    if (![a, b, step].every(Number.isInteger) || a < lo || b > hi || a > b || step < 1) throw new Error(`bad cron field "${src}"`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields, got "${expr}"`);
  const f = parts.map((p, i) => parseField(p, RANGES[i]));
  if (f[4].has(7)) f[4].add(0);
  return { expr, f, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

function partsIn(date, tz) {
  const o = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday];
  return { min: +o.minute, hour: +o.hour, dom: +o.day, mon: +o.month, dow };
}

function matches(c, date, tz) {
  const p = partsIn(date, tz);
  if (!c.f[0].has(p.min) || !c.f[1].has(p.hour) || !c.f[3].has(p.mon)) return false;
  const dom = c.f[2].has(p.dom), dow = c.f[4].has(p.dow);
  // Classic cron: if both day fields are restricted, either may match.
  if (!c.domStar && !c.dowStar) return dom || dow;
  return dom && dow;
}

function nextRun(c, tz, from = new Date()) {
  const t = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  for (let i = 0; i < 60 * 24 * 366; i++, t.setTime(t.getTime() + 60000)) if (matches(c, t, tz)) return new Date(t);
  return null;
}

module.exports = { parseCron, matches, nextRun };
