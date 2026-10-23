import { expect, test } from "bun:test";
import type { DateContext } from "@k2b/stdlib";
import { ConversationSchema } from "../service/contracts";
import { dayLabel, lastMessageLine, listTime, messageTime, sameDay } from "./chat-format";

const config = (locale: string): DateContext => ({ locale, timeZone: "Europe/Berlin", firstDayOfWeek: 1 });

for (const locale of ["en", "de"]) {
  const context = config(locale);
  const now = new Date("2026-10-12T22:15:00Z");
  test(`${locale}: day labels and sidebar times follow Berlin midnight`, () => {
    const today = "2026-10-12T22:05:00Z",
      yesterday = "2026-10-12T21:59:00Z";
    expect(messageTime(today, context)).toBe("00:05");
    expect(sameDay(today, now, context)).toBe(true);
    expect(sameDay(yesterday, now, context)).toBe(false);
    expect(dayLabel(today, now, context)).toBe(locale === "en" ? "Today" : "Heute");
    expect(dayLabel(yesterday, now, context)).toBe(locale === "en" ? "Yesterday" : "Gestern");
    expect(listTime(today, now, context)).toBe("00:05");
    expect(listTime(yesterday, now, context)).toBe(locale === "en" ? "Yesterday" : "Gestern");
    for (const [at, en, de, enShort, deShort] of [
      ["2026-10-11T12:00:00Z", "Sunday", "Sonntag", "Sun", "So"],
      ["2026-10-07T12:00:00Z", "Wednesday", "Mittwoch", "Wed", "Mi"],
    ]) {
      expect(dayLabel(at!, now, context)).toBe(locale === "en" ? en! : de!);
      expect(listTime(at!, now, context)).toBe(locale === "en" ? enShort! : deShort!);
    }
    expect(dayLabel("2026-10-06T12:00:00Z", now, context)).toBe(locale === "en" ? "October 6" : "6. Oktober");
    expect(dayLabel("2025-10-06T12:00:00Z", now, context)).toBe(locale === "en" ? "October 6, 2025" : "6. Oktober 2025");
    expect(listTime("2026-10-06T12:00:00Z", now, context)).toBe(locale === "en" ? "Oct 6" : "6. Okt.");
    expect(listTime("2025-10-06T12:00:00Z", now, context)).toBe(locale === "en" ? "Oct 6, 25" : "6. Okt. 25");
  });

  test(`${locale}: DST transitions compare calendar days rather than elapsed hours`, () => {
    const fall = new Date("2026-10-25T23:15:00Z");
    expect(dayLabel("2026-10-24T22:05:00Z", fall, context)).toBe(locale === "en" ? "Yesterday" : "Gestern");
    expect(listTime("2026-10-24T22:05:00Z", fall, context)).toBe(locale === "en" ? "Yesterday" : "Gestern");
    expect(sameDay("2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z", context)).toBe(true);
    expect(messageTime("2026-10-25T00:30:00Z", context)).toBe("02:30");
    expect(messageTime("2026-10-25T01:30:00Z", context)).toBe("02:30");
    const spring = new Date("2026-03-29T22:15:00Z");
    expect(dayLabel("2026-03-28T23:05:00Z", spring, context)).toBe(locale === "en" ? "Yesterday" : "Gestern");
    expect(dayLabel("2026-03-27T23:05:00Z", spring, context)).toBe(locale === "en" ? "Saturday" : "Samstag");
  });

  test(`${locale}: year inclusion uses the reader's calendar year`, () => {
    const january = new Date("2026-12-31T23:15:00Z");
    expect(dayLabel("2026-12-24T23:30:00Z", january, context)).toBe(locale === "en" ? "December 25, 2026" : "25. Dezember 2026");
  });

  test(`${locale}: last-message lines cover empty, own, direct, and group chats`, () => {
    const conversation = ConversationSchema.parse({
      threads: 0,
      channel: false,
      member: true,
      id: "abcdef",
      name: null,
      icon: null,
      purpose: null,
      title: "Chat",
      memberCount: 2,
      unread: 0,
      read: { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 },
      withGuests: false,
      peerDeactivated: false,
      rev: 1,
      permission: "write",
      createdAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      lastMessage: null,
    });
    expect(lastMessageLine(conversation, "viewer", locale)).toBe(locale === "en" ? "No messages yet" : "Noch keine Nachrichten");
    const lastMessage = {
      thread: null,
      id: "message001",
      author: { type: "user" as const, id: "11111111-1111-4111-8111-111111111111", name: "  Lea Müller " },
      preview: "Hello",
      createdAt: now.toISOString(),
    };
    const direct = { ...conversation, lastMessage };
    expect(lastMessageLine(direct, lastMessage.author.id, locale)).toBe(locale === "en" ? "You: Hello" : "Du: Hello");
    expect(lastMessageLine(direct, "viewer", locale)).toBe("Hello");
    expect(lastMessageLine({ ...direct, memberCount: 3 }, "viewer", locale)).toBe("Lea: Hello");
  });
}
