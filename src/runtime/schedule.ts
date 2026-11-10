// Schedules: fixed intervals ("every") and five-field cron expressions evaluated in a time zone.

import { parseDuration } from "../ids.ts";
import type { ScheduleSpec } from "../system.ts";

interface CronField {
  values: Set<number>;
  any: boolean;
}

interface Cron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

const NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseField(text: string, [min, max]: [number, number], isDow: boolean): CronField {
  const values = new Set<number>();
  const value = (s: string): number => {
    const n = NAMES[s.toLowerCase()] ?? Number(s);
    if (!Number.isInteger(n)) throw new Error(`Bad cron value "${s}"`);
    return isDow && n === 7 ? 0 : n;
  };
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad cron step in "${part}"`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      lo = value(a!);
      hi = value(b!);
    } else {
      lo = value(range!);
      hi = stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron value out of range in "${part}"`);
    for (let n = lo; n <= hi; n += step) values.add(n);
  }
  return { values, any: text === "*" };
}

export function parseCron(expression: string): Cron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`A cron expression has five fields (minute hour day month weekday): "${expression}"`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, RANGES[i]!, i === 4));
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow! };
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function zoned(date: Date, tz: string) {
  let fmt = partsCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    partsCache.set(tz, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    dom: Number(parts.day),
    month: Number(parts.month),
    dow: NAMES[String(parts.weekday).toLowerCase().slice(0, 3)]!,
  };
}

function matches(cron: Cron, date: Date, tz: string): boolean {
  const z = zoned(date, tz);
  if (!cron.minute.values.has(z.minute) || !cron.hour.values.has(z.hour) || !cron.month.values.has(z.month)) return false;
  // Standard cron: when both day fields are restricted, either may match.
  const domOk = cron.dom.values.has(z.dom);
  const dowOk = cron.dow.values.has(z.dow);
  if (!cron.dom.any && !cron.dow.any) return domOk || dowOk;
  return domOk && dowOk;
}

/** The first time strictly after `after` that the cron expression matches, searching up to 366 days. */
export function nextCron(expression: string, after: Date, tz = "UTC"): Date {
  const cron = parseCron(expression);
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = start + 366 * 86_400_000;
  for (let t = start; t <= limit; t += 60_000) {
    const d = new Date(t);
    if (matches(cron, d, tz)) return d;
  }
  throw new Error(`Cron "${expression}" never matches within a year`);
}

/** When a schedule next fires after `after`. */
export function nextFire(schedule: ScheduleSpec, after: Date, defaultTz = "UTC"): Date {
  if (schedule.every) return new Date(after.getTime() + parseDuration(schedule.every));
  if (schedule.cron) return nextCron(schedule.cron, after, schedule.tz ?? defaultTz);
  throw new Error("A schedule needs `every` or `cron`");
}

/** Check a schedule without evaluating it, for `atoll check`. Returns an error message or null. */
export function scheduleProblem(schedule: ScheduleSpec, defaultTz = "UTC"): string | null {
  try {
    if (schedule.every) parseDuration(schedule.every);
    if (schedule.cron) {
      parseCron(schedule.cron);
      new Intl.DateTimeFormat("en-US", { timeZone: schedule.tz ?? defaultTz });
    }
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
