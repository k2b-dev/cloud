import { expect, test } from "bun:test";
import { describeCodeSchedule, describeCodeTiming } from "@k2b/cloud/code/schedule";
import * as ssrSchedule from "@k2b/cloud/ssr/code-schedule";

test("the portable public schedule export and existing SSR entry share one implementation", () => {
  expect(ssrSchedule.describeCodeSchedule).toBe(describeCodeSchedule);
  expect(ssrSchedule.describeCodeTiming).toBe(describeCodeTiming);
});

test("schedule sentences preserve localized common shapes and unfamiliar expressions", () => {
  expect(describeCodeSchedule("0 8 * * 1-5", "de")).toBe("Mo–Fr 08:00");
  expect(describeCodeSchedule("30 6 * * *", "en")).toBe("daily 06:30");
  expect(describeCodeSchedule("*/15 * * * *", "de")).toBe("alle 15 Minuten");
  expect(describeCodeSchedule("0 7 * 1 *", "de")).toBe("0 7 * 1 *");
});

test("timing prioritizes the one-time instant and includes its explicit zone", () => {
  const input = { at: "2026-11-15T10:00:00.000Z", timeZone: "Europe/Berlin", cron: "0 7 * * *" };
  expect(describeCodeTiming(input, "de-DE")).toBe("15.11.2026, 11:00 (Europe/Berlin)");
  expect(describeCodeTiming(input, "en-GB")).toBe("15 Nov 2026, 11:00 (Europe/Berlin)");
  expect(describeCodeTiming({ cron: "30 6 * * *" }, "en")).toBe("daily 06:30");
  expect(describeCodeTiming({}, "de")).toBeNull();
});

test("minute schedules name inclusive hour ranges and weekday restrictions", () => {
  expect(describeCodeSchedule("* 7-20 * * *", "de")).toBe("Jede Minute von 7:00 bis 20:59 Uhr");
  expect(describeCodeSchedule("* 7-20 * * *", "en")).toBe("Every minute between 7:00 and 20:59");
  expect(describeCodeSchedule("*/5 7-20 * * 1-5", "de")).toBe("Alle 5 Minuten von 7:00 bis 20:59 Uhr · Mo–Fr");
  expect(describeCodeSchedule("* 7 * * *", "de")).toBe("Jede Minute von 7:00 bis 7:59 Uhr");
  expect(describeCodeSchedule("* 7-7 * * *", "de")).toBe("Jede Minute von 7:00 bis 7:59 Uhr");
  expect(describeCodeSchedule("* * * * *", "en")).toBe("Every minute");
  expect(describeCodeSchedule("*/15 * * * 1,3", "en")).toBe("Every 15 minutes · Mon, Wed");
  for (const cron of ["* 20-7 * * *", "* 7-24 * * *", "*/0 7-20 * * *", "* 7-20 1 * *"])
    expect(describeCodeSchedule(cron, "de")).toBe(cron);
});
