import { describe, expect, test } from "bun:test";
import { EventInvitationPrepareDataSchema } from "../capability-contracts";
import {
  buildCalendarResponse,
  decideCalendarImport,
  parseCalendarInvitation,
  preparedEventInvitationCalendarFits,
} from "./calendar-invitations";

const request = `BEGIN:VCALENDAR\r
VERSION:2.0\r
METHOD:REQUEST\r
BEGIN:VEVENT\r
UID:planning-42@example.com\r
SEQUENCE:3\r
DTSTART;TZID=Europe/Berlin:20260803T090000\r
DTEND;TZID=Europe/Berlin:20260803T100000\r
SUMMARY:Planning\\, review\r
DESCRIPTION:First line\\nSecond line\r
LOCATION:Room 4\r
ORGANIZER;CN="Alex: Example":mailto:alex@example.com\r
ATTENDEE;CN=Sam;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:sam@example.com\r
RRULE:FREQ=WEEKLY;COUNT=4\r
END:VEVENT\r
END:VCALENDAR\r
`;

describe("calendar invitation protocol", () => {
  test("prepared calendar payload guard enforces the declared capability limit", () => {
    const calendar = EventInvitationPrepareDataSchema.shape.calendar;
    const limit = calendar.maxLength;
    if (limit === null) throw new Error("Expected a bounded prepared invitation");
    const atLimit = "c".repeat(limit - 2);
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(limit);
    expect(preparedEventInvitationCalendarFits(atLimit)).toBeTrue();
    expect(calendar.safeParse(atLimit).success).toBeTrue();
    const oversized = `${atLimit}c`;
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBe(limit + 1);
    expect(calendar.safeParse(oversized).success).toBeTrue();
    expect(preparedEventInvitationCalendarFits(oversized)).toBeFalse();

    const multibyte = "€".repeat(40_000);
    expect(calendar.safeParse(multibyte).success).toBeTrue();
    expect(preparedEventInvitationCalendarFits(multibyte)).toBeFalse();

    const escapedAtLimit = `${"\r\n".repeat((limit - 4) / 4)}cc`;
    expect(Buffer.byteLength(JSON.stringify(escapedAtLimit))).toBe(limit);
    expect(preparedEventInvitationCalendarFits(escapedAtLimit)).toBeTrue();
    const escapedOversized = `${escapedAtLimit}\r\n`;
    expect(calendar.safeParse(escapedOversized).success).toBeTrue();
    expect(Buffer.byteLength(JSON.stringify(escapedOversized))).toBe(limit + 4);
    expect(preparedEventInvitationCalendarFits(escapedOversized)).toBeFalse();
  });
  test("parses a bounded REQUEST with timezone, organizer, attendees, and recurrence", () => {
    const result = parseCalendarInvitation(request);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data).toMatchObject({
      method: "request",
      uid: "planning-42@example.com",
      sequence: 3,
      title: "Planning, review",
      startsAt: "2026-08-03T07:00:00.000Z",
      endsAt: "2026-08-03T08:00:00.000Z",
      recurrenceRule: "FREQ=WEEKLY;COUNT=4",
      organizer: { name: "Alex: Example", address: "alex@example.com" },
    });
    expect(result.data.attendees[0]).toMatchObject({
      name: "Sam",
      address: "sam@example.com",
      role: "required",
      participationStatus: "needs_action",
      responseRequested: true,
    });
  });

  test("parses all-day cancellation deterministically", () => {
    const result = parseCalendarInvitation(
      `BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nUID:day-1\nSEQUENCE:4\nDTSTART;VALUE=DATE:20260803\nDTEND;VALUE=DATE:20260804\nSUMMARY:Offsite\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data).toMatchObject({ method: "cancel", status: "cancelled", allDay: true, sequence: 4 });
  });

  test("rejects missing events, unsupported methods, invalid dates, and reversed ranges", () => {
    expect(parseCalendarInvitation("BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR").ok).toBe(false);
    expect(parseCalendarInvitation(request.replace("METHOD:REQUEST", "METHOD:X-CUSTOM")).ok).toBe(false);
    expect(parseCalendarInvitation(request.replace("20260803T090000", "20261303T090000")).ok).toBe(false);
    expect(parseCalendarInvitation(request.replace("20260803T100000", "20260803T080000")).ok).toBe(false);
  });

  test("builds a standards-compatible, deterministic RSVP envelope", () => {
    const result = buildCalendarResponse({
      mailboxId: "mail01",
      messageId: "msg001",
      calendar: request,
      attendee: { name: "Sam", address: "sam@example.com" },
      participationStatus: "tentative",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.to.address).toBe("alex@example.com");
    expect(result.data.calendar).toContain("METHOD:REPLY");
    expect(result.data.calendar).toContain("ATTENDEE;PARTSTAT=TENTATIVE;CN=Sam:mailto:sam@example.com");
    expect(result.data.calendar).toContain("UID:planning-42@example.com");
    expect(result.data.calendar).toContain("SEQUENCE:3");
  });

  test("classifies duplicate, stale, newer, and cancellation deliveries deterministically", () => {
    const existing = { sequence: 3, method: "request" as const };
    expect(decideCalendarImport({ existing, invitation: { sequence: 3, method: "request", status: "confirmed" } })).toBe("unchanged");
    expect(decideCalendarImport({ existing, invitation: { sequence: 2, method: "request", status: "confirmed" } })).toBe("unchanged");
    expect(decideCalendarImport({ existing, invitation: { sequence: 4, method: "request", status: "confirmed" } })).toBe("apply");
    expect(decideCalendarImport({ existing, invitation: { sequence: 3, method: "cancel", status: "cancelled" } })).toBe("apply");
    expect(decideCalendarImport({ existing: null, invitation: { sequence: 1, method: "cancel", status: "cancelled" } })).toBe(
      "reject_cancellation",
    );
  });
});
