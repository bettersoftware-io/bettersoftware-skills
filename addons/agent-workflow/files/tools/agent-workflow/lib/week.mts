// ISO weeks, in UTC. A week runs Monday to Sunday and belongs to the year its
// Thursday falls in, so `2026-W01` starts on Monday 29 December 2025.

const DAY_MS = 24 * 60 * 60 * 1000;

export class WeekError extends Error {}

export interface Week {
  /** `2026-W40`. */
  name: string;
  /** Its Monday, as `YYYY-MM-DD`. */
  start: string;
  /** Its Sunday, as `YYYY-MM-DD`. */
  end: string;
}

/** The week `date` falls in. */
export function weekOf(date: Date): Week {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const monday = midnight - daysSinceMonday(new Date(midnight)) * DAY_MS;
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;

  return {
    name: `${year}-W${String(number).padStart(2, "0")}`,
    start: toDay(monday),
    end: toDay(monday + 6 * DAY_MS),
  };
}

/** The week a name such as `2026-W40` stands for. Throws `WeekError` for a name that is no week. */
export function parseWeek(name: string): Week {
  const match = /^(\d{4})-W(\d{2})$/.exec(name);

  if (match === null) {
    throw new WeekError(`"${name}" is not an ISO week — expected something like 2026-W40`);
  }

  // 4 January is always in week 1.
  const fourth = Date.UTC(Number(match[1]), 0, 4);
  const firstMonday = fourth - daysSinceMonday(new Date(fourth)) * DAY_MS;
  const week = weekOf(new Date(firstMonday + (Number(match[2]) - 1) * 7 * DAY_MS));

  if (week.name !== name) {
    throw new WeekError(`"${name}" is not an ISO week — ${match[1]} has no week ${Number(match[2])}`);
  }

  return week;
}

/** The newest week that is over at `now`: the one before the week `now` is in. */
export function lastFinishedWeek(now: Date): Week {
  return weekOf(new Date(startOf(weekOf(now)) - DAY_MS));
}

export function weekAfter(week: Week): Week {
  return weekOf(new Date(startOf(week) + 7 * DAY_MS));
}

/** The first instant of the week, in milliseconds. */
export function startOf(week: Week): number {
  return Date.parse(`${week.start}T00:00:00Z`);
}

/** The first instant after the week: the next Monday, 00:00 UTC. */
export function endOf(week: Week): number {
  return startOf(week) + 7 * DAY_MS;
}

/** True when `instant` (an ISO timestamp) falls inside the week. */
export function isInWeek(week: Week, instant: string): boolean {
  const time = Date.parse(instant);

  return time >= startOf(week) && time < endOf(week);
}

function daysSinceMonday(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

function toDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
