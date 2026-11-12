import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type { ScheduledTaskSchedule } from "@t3tools/contracts";

import { isSameSchedule, nextScheduledRunAt, skipsMissedRun } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule(
        { type: "once", runAt: "2026-11-01T03:00:00-05:00" },
        { type: "once", runAt: "2026-11-01T08:00:00.000Z" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});

describe("missed fixed-time runs", () => {
  const dueAt = DateTime.makeZonedUnsafe(
    { year: 2026, month: 11, day: 10, hour: 7, minute: 30, second: 0, millisecond: 0 },
    { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
  );
  const withinGrace = DateTime.add(dueAt, { minutes: 5 });
  const twoHoursLate = DateTime.add(dueAt, { hours: 2 });
  const fixed: ScheduledTaskSchedule = { type: "fixed_time", timeOfDay: "07:30" };

  it("skips a routine fixed-time run more than the grace late", () => {
    expect(skipsMissedRun({ schedule: fixed }, dueAt, withinGrace)).toBe(false);
    expect(skipsMissedRun({ schedule: fixed }, dueAt, twoHoursLate)).toBe(true);
    expect(skipsMissedRun({ schedule: fixed, importance: "routine" }, dueAt, twoHoursLate)).toBe(
      true,
    );
  });

  it("issues an important or time-sensitive run regardless of how late its slot was", () => {
    expect(skipsMissedRun({ schedule: fixed, importance: "important" }, dueAt, twoHoursLate)).toBe(
      false,
    );
    expect(
      skipsMissedRun({ schedule: fixed, importance: "time_sensitive" }, dueAt, twoHoursLate),
    ).toBe(false);
    // The classification only reads on fixed-time schedules; other kinds were never skipped.
    const interval: ScheduledTaskSchedule = { type: "interval", everyMs: 60_000 };
    expect(
      skipsMissedRun({ schedule: interval, importance: "important" }, dueAt, twoHoursLate),
    ).toBe(false);
    const once: ScheduledTaskSchedule = { type: "once", runAt: "2026-11-10T07:30:00.000Z" };
    expect(
      skipsMissedRun({ schedule: once, importance: "time_sensitive" }, dueAt, twoHoursLate),
    ).toBe(false);
  });
});
