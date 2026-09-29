import { describe, expect, test } from "bun:test";
import { calendarLinkView, focusesDay, parseCalendarView, parseShiftSelection, scheduleHref, VENUE_CALENDAR_VIEWS } from "./schedule-url";

describe("Venue schedule URLs", () => {
  test("keep view, day, gaps filter, and selected shift for every calendar view", () => {
    expect(VENUE_CALENDAR_VIEWS.map((view) => scheduleHref("Cafe01", { view, date: "2026-09-29" }))).toEqual([
      "/app/venue/Cafe01/shifts?cv=day&cd=2026-09-29",
      "/app/venue/Cafe01/shifts?cv=week&cd=2026-09-29",
      "/app/venue/Cafe01/shifts?cv=month&cd=2026-09-29",
      "/app/venue/Cafe01/shifts?cv=mobile-month&cd=2026-09-29",
    ]);
    expect(scheduleHref("Cafe01", { view: "week", date: "2026-09-29", gaps: true, shift: "Temp01:2026-09-29" })).toBe(
      "/app/venue/Cafe01/shifts?cv=week&cd=2026-09-29&gaps=1&shift=Temp01:2026-09-29",
    );
    // Without a view, the server uses the view this browser used last.
    expect(scheduleHref("Cafe01", { date: "2026-09-29", shift: "a:Asg001" })).toBe("/app/venue/Cafe01/shifts?cd=2026-09-29&shift=a:Asg001");
    expect(scheduleHref("Cafe01")).toBe("/app/venue/Cafe01/shifts");
  });

  test("mark a day tapped in the phone month view, so its page brings that day's shifts into view", () => {
    const tapped = scheduleHref("Cafe01", { view: "mobile-month", date: "2026-09-30", focusDay: true });
    expect(tapped).toBe("/app/venue/Cafe01/shifts?cv=mobile-month&cd=2026-09-30&focus=day");
    expect(focusesDay(new URL(tapped, "https://cloud.example.test").searchParams)).toBeTrue();
    // A month step only browses.
    const step = scheduleHref("Cafe01", { view: "mobile-month", date: "2026-10-30" });
    expect(focusesDay(new URL(step, "https://cloud.example.test").searchParams)).toBeFalse();
    expect(focusesDay(new URLSearchParams("focus=shift"))).toBeFalse();
  });

  test("read only known views and well-formed selections", () => {
    expect(parseCalendarView("mobile-month")).toBe("mobile-month");
    expect(parseCalendarView("year")).toBeNull();
    expect(parseCalendarView(undefined)).toBeNull();
    expect(parseShiftSelection("Temp01:2026-09-29")).toBe("Temp01:2026-09-29");
    expect(parseShiftSelection("a:Asg001")).toBe("a:Asg001");
    expect(parseShiftSelection("Temp01")).toBeNull();
    expect(parseShiftSelection("a:../x")).toBeNull();
    expect(parseShiftSelection(null)).toBeNull();
  });

  test("the phone month view picks a day instead of leaving for the day view, and Month means it on phones", () => {
    // Day cells of the phone month view ask for the day view.
    expect(calendarLinkView("mobile-month", "day", "date", true)).toBe("mobile-month");
    expect(calendarLinkView("mobile-month", "mobile-month", "date", true)).toBe("mobile-month");
    // The Day option in the switcher still leads to the day view.
    expect(calendarLinkView("mobile-month", "day", "view", true)).toBe("day");
    expect(calendarLinkView("week", "month", "view", true)).toBe("mobile-month");
    expect(calendarLinkView("mobile-month", "month", "view", false)).toBe("month");
    // A day header in the week view opens that day.
    expect(calendarLinkView("week", "day", "date", false)).toBe("day");
    expect(calendarLinkView("month", "month", "date", false)).toBe("month");
    expect(calendarLinkView("week", "year", "view", false)).toBe("week");
  });
});
