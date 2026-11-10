// Days and times in my time zone. "By Friday" means Friday at 17:00 where I am, so these turn calendar
// days in a time zone into instants and back. They use only Intl's numeric fields and their own names
// for days and months, so the results don't change between ICU versions.

export interface Day {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The calendar day and wall-clock time an instant falls on in a time zone. */
export function wallClock(instant: Date, timeZone: string): Day & { hour: number; minute: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return { year: parts.year ?? 0, month: parts.month ?? 0, day: parts.day ?? 0, hour: (parts.hour ?? 0) % 24, minute: parts.minute ?? 0 };
}

/** Minutes the zone is ahead of UTC at an instant; negative west of Greenwich. */
function offsetMinutes(ms: number, timeZone: string): number {
  const w = wallClock(new Date(ms), timeZone);
  return Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - ms) / 60_000);
}

/** The instant a wall-clock time happens on a day in a time zone. */
export function at(day: Day, hour: number, timeZone: string, minute = 0): Date {
  const wall = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  const first = wall - offsetMinutes(wall, timeZone) * 60_000;
  // A second pass lands on the right side of a daylight-saving change.
  return new Date(wall - offsetMinutes(first, timeZone) * 60_000);
}

export function addDays(day: Day, n: number): Day {
  const d = new Date(Date.UTC(day.year, day.month - 1, day.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 for Sunday through 6 for Saturday. */
export function weekday(day: Day): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

export function isRealDay(day: Day): boolean {
  const d = new Date(Date.UTC(day.year, day.month - 1, day.day));
  return d.getUTCFullYear() === day.year && d.getUTCMonth() + 1 === day.month && d.getUTCDate() === day.day;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Friday, November 6": the day an instant falls on in a time zone. */
export function dayName(instant: Date | string, timeZone: string): string {
  const day = wallClock(new Date(instant), timeZone);
  return `${WEEKDAYS[weekday(day)]}, ${MONTHS[day.month - 1]} ${day.day}`;
}
