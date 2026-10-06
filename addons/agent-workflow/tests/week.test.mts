import { describe, expect, it, onTestFinished, vi } from "vitest";

import { endOf, isInWeek, lastFinishedWeek, parseWeek, startOf, weekAfter, WeekError, weekOf } from "../files/tools/agent-workflow/lib/week.mts";

describe("the ISO week a day falls in", () => {
  it.each([
    ["2026-09-28T00:00:00Z", "2026-W40", "2026-09-28", "2026-10-04"],
    ["2026-10-04T23:59:59Z", "2026-W40", "2026-09-28", "2026-10-04"],
    ["2026-10-05T00:00:00Z", "2026-W41", "2026-10-05", "2026-10-11"],
    ["2026-10-07T12:00:00Z", "2026-W41", "2026-10-05", "2026-10-11"],
    // The year of a week is the year of its Thursday.
    ["2025-12-29T00:00:00Z", "2026-W01", "2025-12-29", "2026-01-04"],
    ["2027-01-03T10:00:00Z", "2026-W53", "2026-12-28", "2027-01-03"],
    ["2021-01-03T10:00:00Z", "2020-W53", "2020-12-28", "2021-01-03"],
    ["2024-12-30T00:00:00Z", "2025-W01", "2024-12-30", "2025-01-05"],
  ])("%s is in %s", (instant, name, start, end) => {
    expect(weekOf(new Date(instant))).toEqual({ name, start, end });
  });

  it("reads the day in UTC, whatever the hour and wherever it is run", () => {
    // In Chicago this instant is still Sunday evening, in week 40.
    vi.stubEnv("TZ", "America/Chicago");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    expect(weekOf(new Date("2026-10-04T23:30:00-05:00")).name).toBe("2026-W41");
  });
});

describe("a week's name", () => {
  it.each(["2026-W40", "2026-W01", "2026-W53", "2025-W01", "2020-W53", "2024-W52", "2021-W01", "2027-W01", "2023-W01"])("%s reads back as itself", (name) => {
    expect(parseWeek(name).name).toBe(name);
    expect(weekOf(new Date(startOf(parseWeek(name)))).name).toBe(name);
  });

  it("gives the week's Monday and Sunday", () => {
    expect(parseWeek("2026-W40")).toEqual({ name: "2026-W40", start: "2026-09-28", end: "2026-10-04" });
    expect(parseWeek("2026-W01")).toEqual({ name: "2026-W01", start: "2025-12-29", end: "2026-01-04" });
  });

  it.each(["2026-W54", "2025-W53", "2026-W00", "2026-40", "W40", "2026-W4", "2026-w40", "", "2026-W40 "])("refuses %j", (name) => {
    expect(() => parseWeek(name)).toThrow(WeekError);
  });
});

describe("the last finished week", () => {
  it("is the week before the one now is in, from the first second of Monday", () => {
    expect(lastFinishedWeek(new Date("2026-10-05T00:05:00Z")).name).toBe("2026-W40");
    expect(lastFinishedWeek(new Date("2026-10-11T23:59:59Z")).name).toBe("2026-W40");
    expect(lastFinishedWeek(new Date("2026-10-12T00:00:00Z")).name).toBe("2026-W41");
  });

  it("crosses a year", () => {
    expect(lastFinishedWeek(new Date("2027-01-04T00:05:00Z")).name).toBe("2026-W53");
  });
});

describe("a week's bounds", () => {
  const week = parseWeek("2026-W40");

  it("holds its first instant and not the next Monday's", () => {
    expect(isInWeek(week, "2026-09-28T00:00:00Z")).toBe(true);
    expect(isInWeek(week, "2026-10-04T23:59:59Z")).toBe(true);
    expect(isInWeek(week, "2026-10-05T00:00:00Z")).toBe(false);
    expect(isInWeek(week, "2026-09-27T23:59:59Z")).toBe(false);
  });

  it("ends where the next one starts", () => {
    expect(endOf(week)).toBe(startOf(weekAfter(week)));
    expect(weekAfter(week).name).toBe("2026-W41");
    expect(weekAfter(parseWeek("2026-W53")).name).toBe("2027-W01");
  });
});
