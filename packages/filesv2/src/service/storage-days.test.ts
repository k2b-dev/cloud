import { expect, test } from "bun:test";
import { CHANGE_DAYS } from "../contracts";
import { changeDays, dailySeries } from "./storage-days";

test("the series covers the reader's last 30 days, oldest first, ending on the reader's today", () => {
  // 00:30 on 16 May in Berlin while UTC still says 15 May
  const now = new Date("2030-05-15T22:30:00.000Z");
  const berlin = changeDays(now, "Europe/Berlin");
  expect(berlin).toHaveLength(CHANGE_DAYS);
  expect([berlin[0], berlin.at(-1)]).toEqual(["2030-04-17", "2030-05-16"]);
  expect(changeDays(now, "UTC").at(-1)).toBe("2030-05-15");
  // 15:30 on 15 May in Los Angeles: the day before UTC's at 01:00
  expect(changeDays(new Date("2030-05-16T01:00:00.000Z"), "America/Los_Angeles").at(-1)).toBe("2030-05-15");
  // a change of the clock in the window keeps one entry per day, none twice and none missing
  const spring = changeDays(new Date("2030-04-10T12:00:00.000Z"), "Europe/Berlin");
  expect(new Set(spring).size).toBe(CHANGE_DAYS);
  expect(spring.slice(18, 21)).toEqual(["2030-03-30", "2030-03-31", "2030-04-01"]);
});

test("counts land on their day, a storage without changes in the window has no series, and the total is the read's own", () => {
  const days = changeDays(new Date("2030-05-15T22:30:00.000Z"), "Europe/Berlin");
  const series = dailySeries(days, [
    // only outside the window: no series
    { baseId: "group", day: "2030-04-16", changes: 4 },
    { baseId: "home", day: "2030-05-16", changes: 2 },
    { baseId: "home", day: "2030-04-17", changes: 1 },
    // a day outside the window (a clock ahead of the database's) is left out
    { baseId: "home", day: "2030-05-17", changes: 9 },
    { baseId: null, day: "2030-05-16", changes: 2 },
    { baseId: null, day: "2030-04-17", changes: 1 },
  ]);
  expect(series.from).toBe("2030-04-17");
  const home = series.storages.find((storage) => storage.baseId === "home")!.days;
  expect([home[0], home.at(-1), home.reduce((sum, value) => sum + value, 0)]).toEqual([1, 2, 3]);
  expect(home).toHaveLength(CHANGE_DAYS);
  expect(series.storages.map((storage) => storage.baseId)).toEqual(["home"]);
  // the total counts a change between two storages once, as the read says, not as the sum of both
  expect([series.total[0], series.total.at(-1)]).toEqual([1, 2]);
  expect(dailySeries(days, [])).toEqual({ from: "2030-04-17", total: Array(CHANGE_DAYS).fill(0), storages: [] });
});
