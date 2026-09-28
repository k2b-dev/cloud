import { describe, expect, test } from "bun:test";
import { VenueDashboardQuerySchema } from "../contracts";
import { sameVenueDashboardSource, slotWindow, venueDashboardRouteScope } from "./dashboard-query";

describe("venue dashboard query scope", () => {
  test("uses the same calendar window for SSR options and browser query input", () => {
    const scope = venueDashboardRouteScope({
      venueId: "11111111-1111-4111-8111-111111111111",
      view: "shifts",
      calendarView: "month",
      calendarDate: "2026-08-10",
      feedbackDays: 30,
      feedbackSearch: "",
      feedbackComments: false,
      feedbackPage: 1,
    });

    expect(scope.options).toEqual({
      // The month grid starts on the Monday before August 1 and shows six weeks.
      slotStartDate: "2026-07-27",
      slotDays: 42,
      includeFeedbackEntries: false,
      feedbackDays: 30,
      feedbackSearch: undefined,
      feedbackPage: undefined,
    });
    expect(VenueDashboardQuerySchema.parse(scope.source.query)).toEqual(scope.options);
  });

  test("preserves the feedback scope and normalizes empty search", () => {
    const scope = venueDashboardRouteScope({
      venueId: "11111111-1111-4111-8111-111111111111",
      view: "feedback",
      calendarView: "week",
      calendarDate: "2026-08-10",
      feedbackDays: 14,
      feedbackSearch: "late shift",
      feedbackComments: false,
      feedbackPage: 3,
    });

    expect(VenueDashboardQuerySchema.parse(scope.source.query)).toEqual(scope.options);
    expect(scope.options).toMatchObject({
      slotStartDate: "2026-08-10",
      slotDays: 14,
      includeFeedbackEntries: true,
      feedbackDays: 14,
      feedbackSearch: "late shift",
      feedbackPage: 3,
    });
  });

  test("asks for a feedback page only in the feedback view and only beyond the first page", () => {
    const scope = (view: "shifts" | "feedback", feedbackPage: number) =>
      venueDashboardRouteScope({
        venueId: "11111111-1111-4111-8111-111111111111",
        view,
        calendarView: "week",
        calendarDate: "2026-08-10",
        feedbackDays: 30,
        feedbackSearch: "",
        feedbackComments: false,
        feedbackPage,
      });

    expect(scope("feedback", 1).source.query.feedbackPage).toBeUndefined();
    expect(scope("shifts", 4).source.query.feedbackPage).toBeUndefined();
    expect(scope("feedback", 4).source.query.feedbackPage).toBe("4");
  });

  test("compares every canonical source field", () => {
    const source = venueDashboardRouteScope({
      venueId: "11111111-1111-4111-8111-111111111111",
      view: "feedback",
      calendarView: "week",
      calendarDate: "2026-08-10",
      feedbackDays: 30,
      feedbackSearch: "",
      feedbackComments: false,
      feedbackPage: 2,
    }).source;

    expect(sameVenueDashboardSource(source, { ...source, query: { ...source.query } })).toBe(true);
    expect(sameVenueDashboardSource(source, { ...source, query: { ...source.query, slotDays: "45" } })).toBe(false);
    expect(sameVenueDashboardSource(source, { ...source, query: { ...source.query, feedbackPage: "3" } })).toBe(false);
    expect(sameVenueDashboardSource(source, { ...source, query: { ...source.query, feedbackComments: "true" } })).toBe(false);
  });

  test("asks for entries with a comment only in the feedback view", () => {
    const scope = (view: "shifts" | "feedback") =>
      venueDashboardRouteScope({
        venueId: "11111111-1111-4111-8111-111111111111",
        view,
        calendarView: "week",
        calendarDate: "2026-08-10",
        feedbackDays: 30,
        feedbackSearch: "",
        feedbackComments: true,
        feedbackPage: 1,
      });

    expect(scope("feedback").source.query.feedbackComments).toBe("true");
    expect(VenueDashboardQuerySchema.parse(scope("feedback").source.query)).toEqual(scope("feedback").options);
    expect(scope("shifts").source.query.feedbackComments).toBeUndefined();
  });

  test("loads exactly the days each calendar view shows", () => {
    // 2026-08-12 is a Wednesday; August 2026 starts on a Saturday.
    expect(slotWindow("day", "2026-08-12")).toEqual({ startDate: "2026-08-12", days: 1 });
    expect(slotWindow("week", "2026-08-12")).toEqual({ startDate: "2026-08-10", days: 7 });
    expect(slotWindow("week", "2026-08-16")).toEqual({ startDate: "2026-08-10", days: 7 });
    expect(slotWindow("month", "2026-08-31")).toEqual({ startDate: "2026-07-27", days: 42 });
    expect(slotWindow("mobile-month", "2026-08-12")).toEqual({ startDate: "2026-07-27", days: 42 });
  });

  test("rejects unbounded browser query input", () => {
    expect(() => VenueDashboardQuerySchema.parse({ slotDays: "365" })).toThrow();
    expect(() => VenueDashboardQuerySchema.parse({ feedbackSearch: "x".repeat(201) })).toThrow();
    expect(() => VenueDashboardQuerySchema.parse({ feedbackPage: "0" })).toThrow();
  });
});
