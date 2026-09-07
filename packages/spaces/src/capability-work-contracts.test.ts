import { describe, expect, test } from "bun:test";
import { decodeWorkCursor, EventAgendaInputSchema, encodeWorkCursor, TaskFocusInputSchema } from "./capability-work-contracts";
import { CalendarReadLimitError, expandRecurringEvents } from "./service/recurrence";

describe("Spaces work query contracts", () => {
  test("focus defaults to a small cross-space page and accepts domain filters", () => {
    expect(TaskFocusInputSchema.parse({})).toEqual({ limit: 25, query: "", assignedTo: "all", activity: "all", deadlineFilter: "all" });
    expect(TaskFocusInputSchema.parse({ activity: "inactive", deadlineFilter: "overdue", blocked: true }).blocked).toBe(true);
    expect(TaskFocusInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
  test("agenda requires ordered, timezone-aware boundaries", () => {
    expect(EventAgendaInputSchema.safeParse({ from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" }).success).toBe(false);
    expect(EventAgendaInputSchema.safeParse({ from: "2026-01-01T00:00:00", to: "2026-01-02T00:00:00" }).success).toBe(false);
    expect(EventAgendaInputSchema.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" }).success).toBe(false);
    expect(EventAgendaInputSchema.parse({ from: "2026-01-01T00:00:00+01:00", to: "2026-01-02T00:00:00+01:00" }).limit).toBe(25);
  });
  test("cursor rejects malformed and unsafe offsets", () => {
    expect(decodeWorkCursor(encodeWorkCursor(100))).toBe(100);
    expect(() => decodeWorkCursor("invalid")).toThrow();
    expect(() => decodeWorkCursor(encodeWorkCursor(-1))).toThrow();
    expect(() => decodeWorkCursor(encodeWorkCursor(Number.MAX_SAFE_INTEGER + 1))).toThrow();
  });
  test("strict recurrence expansion fails rather than silently returning partial dates", () => {
    const input = {
      events: [
        {
          id: "series",
          title: "Daily",
          start: "2026-01-01T09:00:00Z",
          end: "2026-01-01T10:00:00Z",
          recurrence: { rrule: "FREQ=DAILY", dtstart: "2026-01-01T09:00:00Z", exdate: [] },
        },
      ],
      rangeStart: "2026-01-01T00:00:00Z",
      rangeEnd: "2026-01-10T00:00:00Z",
      expansionLimit: 2,
    };
    expect(expandRecurringEvents(input)).toHaveLength(2);
    expect(() => expandRecurringEvents({ ...input, requireComplete: true })).toThrow(CalendarReadLimitError);
    expect(() => expandRecurringEvents({ ...input, expansionLimit: 100, generationLimit: 2, requireComplete: true })).toThrow(
      CalendarReadLimitError,
    );
  });
});
