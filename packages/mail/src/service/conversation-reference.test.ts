import { describe, expect, test } from "bun:test";
import { DEFAULT_CONVERSATION_REFERENCE_PATTERN } from "../contracts";
import {
  addConversationReferenceToReplySubject,
  formatConversationReference,
  validateConversationReferencePattern,
} from "./conversation-reference";

describe("conversation reference formatting", () => {
  test("lists available scalar variables for an unknown root", () => {
    expect(validateConversationReferencePattern("MAIL-{{ seq }}")).toMatchObject({
      ok: false,
      error: {
        message:
          'Mail template variable "seq" is not available here. Available: short_id, uuid, uuid_v7, ulid, sequence, year, month, month_name, day.',
      },
    });
  });

  test("uses a privacy-safe default", () => {
    expect(DEFAULT_CONVERSATION_REFERENCE_PATTERN).toBe("REF-{{ short_id }}");
    expect(
      formatConversationReference({
        pattern: DEFAULT_CONVERSATION_REFERENCE_PATTERN,
        sequence: 42n,
        allocatedAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
    ).toMatchObject({ ok: true, data: expect.stringMatching(/^REF-[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){2}$/) });
  });

  test("renders sequence and UTC date tokens", () => {
    const result = formatConversationReference({
      pattern: "SUP-{{ year }}-{{ month }}-{{ month_name }}-{{ day }}-{{ sequence | pad_start: 6 }}",
      sequence: 42n,
      allocatedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    expect(result).toEqual({ ok: true, data: "SUP-2026-07-July-20-000042" });
  });

  test("renders every supported identity", () => {
    const allocatedAt = new Date("2026-07-20T12:00:00.000Z");
    const shortId = formatConversationReference({ pattern: "{{ short_id }}", sequence: 42n, allocatedAt });
    const uuid = formatConversationReference({ pattern: "{{ uuid }}", sequence: 42n, allocatedAt });
    const uuidV7 = formatConversationReference({ pattern: "{{ uuid_v7 }}", sequence: 42n, allocatedAt });
    const ulid = formatConversationReference({ pattern: "{{ ulid }}", sequence: 42n, allocatedAt });
    const sequence = formatConversationReference({ pattern: "{{ sequence }}", sequence: 42n, allocatedAt });
    expect(shortId.ok && shortId.data).toMatch(/^[23456789A-HJ-NP-Za-hj-km-np-z]{4}(?:-[23456789A-HJ-NP-Za-hj-km-np-z]{4}){2}$/);
    expect(uuid.ok && uuid.data).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidV7.ok && uuidV7.data).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ulid.ok && ulid.data).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(sequence).toEqual({ ok: true, data: "42" });
  });

  test("requires exactly one safe identity output", () => {
    expect(
      formatConversationReference({
        pattern: "SUP-{{ year }}",
        sequence: 42n,
        allocatedAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
    ).toMatchObject({ ok: false });
    expect(
      formatConversationReference({
        pattern: "{{ short_id }}-{{ uuid }}",
        sequence: 42n,
        allocatedAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
    ).toMatchObject({ ok: false });
    expect(
      formatConversationReference({
        pattern: "{{ short_id }}-{{ short_id }}",
        sequence: 42n,
        allocatedAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
    ).toMatchObject({ ok: false });
    expect(
      formatConversationReference({
        pattern: "{% if year %}{{ short_id }}{% endif %}",
        sequence: 42n,
        allocatedAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
    ).toMatchObject({ ok: false });
    expect(
      formatConversationReference({
        pattern: "{{ message.subject }}-{{ short_id }}",
        sequence: 42n,
        allocatedAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
    ).toMatchObject({ ok: false });
  });

  test("adds one reference after the reply prefix", () => {
    expect(addConversationReferenceToReplySubject("Original subject", "SUP-2026-000042")).toBe("Re: [SUP-2026-000042] Original subject");
    expect(addConversationReferenceToReplySubject("RE: Original subject", "SUP-2026-000042")).toBe(
      "Re: [SUP-2026-000042] Original subject",
    );
    expect(addConversationReferenceToReplySubject("Re: [SUP-2026-000042] Original subject", "SUP-2026-000042")).toBe(
      "Re: [SUP-2026-000042] Original subject",
    );
  });

  test("keeps the resulting subject inside the mail limit", () => {
    expect(addConversationReferenceToReplySubject("x".repeat(2_000), "SUP-42")).toHaveLength(998);
  });
});
