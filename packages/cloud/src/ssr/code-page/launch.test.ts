import { expect, test } from "bun:test";
import { headActionFixture } from "./head-action.fixture";
import { launchPages, opensPage, routeTitle, runnable } from "./launch";
import { codePageMessages } from "./messages";

const ready = () => {
  const data = headActionFixture("both");
  if (data.state.kind !== "ready" || !data.state.runs) throw new Error("Expected ready fixture with run history");
  return data.state;
};
test("the browser consumes Core's projection and localizes fallback titles without inferring eligibility from routes", () => {
  const state = ready();
  const home = state.automations![0]!;
  expect(opensPage(home)).toBe(true);
  expect(opensPage({ ...home, isNew: true })).toBe(false);
  expect(opensPage({ ...home, pageLink: undefined })).toBe(false);
  expect(routeTitle(home, { t: () => codePageMessages.resolve(["de"]).t })).toBe("Startseite");
  expect(routeTitle(home, { t: () => codePageMessages.resolve(["en"]).t })).toBe("Home page");
  expect(launchPages(state)).toBe(state.pages!.pages);
  state.automations = [];
  expect(launchPages(state).map((page) => page.href)).toEqual([`/code/${state.code.id}/`, `/code/${state.code.id}/archive`]);
  state.pages = null;
  state.automations = [home];
  expect(launchPages(state)).toEqual([]);
});
test("only editors of an active Code can start current manual and scheduled entries", () => {
  const state = ready();
  expect(runnable(state).map((item) => item.kind)).toEqual(["schedule", "schedule"]);
  state.permission = "reader";
  expect(runnable(state)).toEqual([]);
  state.permission = "editor";
  state.code.state = "paused";
  expect(runnable(state)).toEqual([]);
});

test("head fixtures keep recurring dates, unscheduled triggers and reader identity consistent", () => {
  for (const name of [
    "manual",
    "events",
    "schedule",
    "schedules",
    "both",
    "reader",
    "reader-page",
    "reader-waiting",
    "paused-reader",
  ] as const) {
    const data = headActionFixture(name);
    if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
    for (const item of data.state.automations ?? []) {
      if (item.kind === "event" || item.kind === "manual") expect(item.nextRunAt).toBeNull();
      if (item.kind === "schedule") {
        const next = new Date(item.nextRunAt!);
        expect(next.getTime()).toBeGreaterThan(Date.parse(data.dates.now));
        expect(
          new Intl.DateTimeFormat("en", {
            timeZone: data.dates.timeZone,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).format(next),
        ).toBe(item.entrypoint === "reminder" ? "Fri 16:00" : "Mon 08:00");
        expect(item.lastRun?.entrypoint).toBe(item.entrypoint);
        expect(
          new Intl.DateTimeFormat("en", {
            timeZone: data.dates.timeZone,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).format(new Date(item.lastRun!.createdAt)),
        ).toBe(item.entrypoint === "reminder" ? "Fri 16:00" : "Mon 08:00");
        expect(data.state.runs.items.find((run) => run.id === item.lastRun?.id)).toEqual(item.lastRun);
      }
    }
    if (data.state.permission === "reader") expect(data.owner.runsAs).toEqual({ name: "Lena" });
    for (const run of data.state.runs.items.filter((run) => run.entrypoint === "wochenbericht"))
      expect(
        new Intl.DateTimeFormat("en", {
          timeZone: data.dates.timeZone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(new Date(run.createdAt)),
      ).toBe("08:00");
  }
});
