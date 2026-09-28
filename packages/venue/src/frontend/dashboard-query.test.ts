import { describe, expect, test } from "bun:test";
import { VenueDashboardQuerySchema } from "../contracts";
import { sameVenueDashboardSource, venueDashboardRouteScope } from "./dashboard-query";

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
      slotStartDate: "2026-08-03",
      slotDays: 45,
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

  test("rejects unbounded browser query input", () => {
    expect(() => VenueDashboardQuerySchema.parse({ slotDays: "365" })).toThrow();
    expect(() => VenueDashboardQuerySchema.parse({ feedbackSearch: "x".repeat(201) })).toThrow();
    expect(() => VenueDashboardQuerySchema.parse({ feedbackPage: "0" })).toThrow();
  });
});
