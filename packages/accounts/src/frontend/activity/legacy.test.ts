import { describe, expect, test } from "bun:test";
import { legacyAuditHref } from "../audit/query";
import { legacyDeletedHref } from "../deleted-accounts/query";
import { legacyBatchHref, legacyNotificationsHref } from "../notifications/query";
import { legacyRemindersHref } from "../reminders/query";

const params = (text: string) => new URLSearchParams(text);

describe("the addresses of the pages the activity page replaced", () => {
  test("the audit log is the default kind and keeps every filter; only the search moves to q", () => {
    expect(legacyAuditHref(params(""))).toBe("/app/accounts/activity");
    expect(
      legacyAuditHref(params("search=Runtime&actor=Ada&outcome=denied&days=7&serviceAccountId=a-1&automatic=1&page=3&extra=keep")),
    ).toBe("/app/accounts/activity?actor=Ada&outcome=denied&days=7&serviceAccountId=a-1&automatic=yes&page=3&extra=keep&q=Runtime");
    // a q that is already there wins over the old search
    expect(legacyAuditHref(params("search=old&q=new"))).toBe("/app/accounts/activity?q=new");
  });

  test("the notification list keeps its status and page, and the form for a new batch", () => {
    expect(legacyNotificationsHref(params(""))).toBe("/app/accounts/activity?kind=notifications");
    expect(legacyNotificationsHref(params("status=completed_with_errors&page=2&new=1"))).toBe(
      "/app/accounts/activity?kind=notifications&status=completed_with_errors&page=2&new=1",
    );
  });

  test("a batch opens as its record with its recipient filter and page", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(legacyBatchHref(id, params(""))).toBe(`/app/accounts/activity/notifications/${id}`);
    expect(legacyBatchHref(id, params("recipient_status=error&page=4"))).toBe(
      `/app/accounts/activity/notifications/${id}?page=4&status=error`,
    );
  });

  test("reminders keep status, search and page; the old reminder-kind filter (one kind only) leaves", () => {
    expect(legacyRemindersHref(params("search=ada&status=error&kind=account_expiry&page=2"))).toBe(
      "/app/accounts/activity?kind=reminders&status=error&page=2&q=ada",
    );
  });

  test("deleted accounts keep reason, search, page and the open entry", () => {
    expect(legacyDeletedHref(params("search=milan&reason=manual_delete&page=2&entry=e-1"))).toBe(
      "/app/accounts/activity?kind=deleted&reason=manual_delete&page=2&entry=e-1&q=milan",
    );
  });
});
