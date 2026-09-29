import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { isInNoticeWindow, isReminderDue, noticeKeys, noticeRecipients, noticeWindow, noticeWindowDays } from "./shift-notices";

const berlin = "Europe/Berlin";
/** The instant of a Berlin clock time; 2026 moves clocks forward on March 29 and back on October 25. */
const inBerlin = (local: string) => new Date(dates.zonedDateTimeToInstant(local, berlin, { disambiguation: "compatible" }));

describe("Venue notice idempotency keys", () => {
  test("name the sign-up and its start, the slot and its recipient, or the cancelled sign-up", () => {
    expect(noticeKeys.reminder("assignment-1", "2026-09-30T16:00:00.000Z")).toBe("venue:reminder:assignment-1:2026-09-30T16:00:00.000Z");
    expect(noticeKeys.understaffed("template-1", "2026-09-30", "user-1")).toBe("venue:understaffed:template-1:2026-09-30:user-1");
    expect(noticeKeys.cancelled("assignment-1")).toBe("venue:cancelled:assignment-1");
  });
});

describe("Venue notice recipients", () => {
  test("reach every admin once and leave out the person who acted", () => {
    const admins = [{ id: "admin-a" }, { id: "admin-b" }, { id: "admin-a" }];
    expect(noticeRecipients(admins, null)).toEqual(["admin-a", "admin-b"]);
    expect(noticeRecipients(admins, "admin-b")).toEqual(["admin-a"]);
    expect(noticeRecipients(admins, "staff-1")).toEqual(["admin-a", "admin-b"]);
    expect(noticeRecipients([{ id: "admin-a" }], "admin-a")).toEqual([]);
  });
});

describe("Venue notice window", () => {
  test("covers shifts that start after the scan and at most 24 hours later", () => {
    const window = noticeWindow(new Date("2026-09-29T10:00:00.000Z"));
    expect(isInNoticeWindow("2026-09-29T10:00:00.000Z", window)).toBe(false);
    expect(isInNoticeWindow("2026-09-29T10:15:00.000Z", window)).toBe(true);
    expect(isInNoticeWindow("2026-09-30T10:00:00.000Z", window)).toBe(true);
    expect(isInNoticeWindow("2026-09-30T10:00:00.001Z", window)).toBe(false);
  });

  test("touches three venue days across the short night and one across the long night", () => {
    // 23:30 on March 28 plus 24 hours is 00:30 on March 30: March 29 has only 23 hours.
    const spring = noticeWindow(inBerlin("2026-03-28T23:30"));
    expect(noticeWindowDays(spring, berlin)).toEqual({ startDate: "2026-03-28", days: 3 });
    expect(isInNoticeWindow(inBerlin("2026-03-30T00:15").toISOString(), spring)).toBe(true);
    expect(isInNoticeWindow(inBerlin("2026-03-30T00:45").toISOString(), spring)).toBe(false);

    // 00:30 on October 25 plus 24 hours is 23:30 the same day: October 25 has 25 hours.
    const autumn = noticeWindow(inBerlin("2026-10-25T00:30"));
    expect(noticeWindowDays(autumn, berlin)).toEqual({ startDate: "2026-10-25", days: 1 });
    expect(isInNoticeWindow(inBerlin("2026-10-25T23:15").toISOString(), autumn)).toBe(true);
    expect(isInNoticeWindow(inBerlin("2026-10-26T00:15").toISOString(), autumn)).toBe(false);
  });

  test("uses the venue's days, not the server's", () => {
    const window = noticeWindow(new Date("2026-09-29T23:30:00.000Z"));
    expect(noticeWindowDays(window, berlin)).toEqual({ startDate: "2026-09-30", days: 2 });
    expect(noticeWindowDays(window, "America/New_York")).toEqual({ startDate: "2026-09-29", days: 2 });
  });
});

describe("Venue shift reminders", () => {
  const createdAt = "2026-03-20T12:00:00.000Z";

  test("are due 24 hours before the start, also when the clocks change in between", () => {
    // 09:00 summer time on March 29 is 24 hours after 08:00 winter time on March 28.
    const startsAt = inBerlin("2026-03-29T09:00").toISOString();
    expect(isReminderDue({ startsAt, createdAt }, inBerlin("2026-03-28T07:59"))).toBe(false);
    expect(isReminderDue({ startsAt, createdAt }, inBerlin("2026-03-28T08:00"))).toBe(true);
    expect(isReminderDue({ startsAt, createdAt }, inBerlin("2026-03-29T08:59"))).toBe(true);
    expect(isReminderDue({ startsAt, createdAt }, inBerlin("2026-03-29T09:00"))).toBe(false);

    // 09:00 winter time on October 25 is 24 hours after 10:00 summer time on October 24.
    const autumnStart = inBerlin("2026-10-25T09:00").toISOString();
    expect(isReminderDue({ startsAt: autumnStart, createdAt }, inBerlin("2026-10-24T09:59"))).toBe(false);
    expect(isReminderDue({ startsAt: autumnStart, createdAt }, inBerlin("2026-10-24T10:00"))).toBe(true);
  });

  test("skip sign-ups made less than 24 hours before the shift", () => {
    const startsAt = "2026-09-30T16:00:00.000Z";
    const now = new Date("2026-09-30T08:00:00.000Z");
    expect(isReminderDue({ startsAt, createdAt: "2026-09-29T16:00:00.000Z" }, now)).toBe(true);
    expect(isReminderDue({ startsAt, createdAt: "2026-09-29T16:00:00.001Z" }, now)).toBe(false);
  });
});
