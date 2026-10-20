import { describe, expect, test } from "bun:test";
import { mailboxCurrentTab, mailboxViewTabs } from "./mail-view-tabs";

const root = { scheduledMode: false, draftsMode: false, folderId: null, activeView: null, savedViewId: null };
const expectedViews = ["needs_action", "mine", "waiting", "unassigned", "snoozed", "done", "recently_active", "kept"] as const;
const counts = { needs_action: 3, mine: 2, waiting: 1, unassigned: 4, snoozed: 5, done: 6, recently_active: 7, kept: 8, send_problems: 9 };
describe("mailbox head tabs", () => {
  test("the root and mailbox-wide search select All", () => {
    expect(mailboxCurrentTab(root)).toBe("all");
    // Search is mailbox-wide; its expression lives in a head chip, outside tab state.
    const url = new URL(
      "/app/mail/Box001?search=%7B%22expression%22%3A%7B%22type%22%3A%22has_attachment%22%7D%2C%22sort%22%3A%22newest%22%7D",
      "https://cloud.test",
    );
    expect(mailboxCurrentTab({ ...root, folderId: url.searchParams.get("folder") })).toBe("all");
  });
  test.each([...expectedViews])("selects %s", (activeView) => expect(mailboxCurrentTab({ ...root, activeView })).toBe(activeView));
  test("saved views have their own IDs", () => expect(mailboxCurrentTab({ ...root, savedViewId: "Saved1" })).toBe("saved:Saved1"));
  test.each([{ folderId: "Inbox1" }, { draftsMode: true }, { scheduledMode: true }, { activeView: "send_problems" as const }])(
    "places suppress tabs: %j",
    (place) => {
      expect(mailboxCurrentTab({ ...root, ...place })).toBeNull();
    },
  );
  const input = {
    mailboxId: "Box001",
    viewCounts: counts,
    assignedOnly: false,
    labels: {
      all: "All",
      needs_action: "Needs action",
      mine: "Assigned to me",
      waiting: "Waiting for reply",
      unassigned: "Unassigned",
      snoozed: "Later",
      done: "Done",
      recently_active: "Recent activity",
      kept: "Kept",
    },
    formatCount: (count: number) => `#${count}`,
    savedViews: [
      {
        id: "Saved1",
        mailboxId: "Box001",
        name: "Invoices",
        scope: "private" as const,
        ownerUserId: "user-1",
        filter: { expression: { type: "work_status" as const, value: "needs_action" as const }, sort: "newest" as const },
        revision: 1,
        createdAt: "2026-10-14T10:00:00Z",
        updatedAt: "2026-10-14T10:00:00Z",
      },
    ],
  };
  test("All comes first, followed by ordered views and saved views with reloadable hrefs", () => {
    const tabs = mailboxViewTabs(input);
    expect(tabs.map((tab) => tab.id)).toEqual(["all", ...expectedViews, "saved:Saved1"]);
    expect(tabs.map((tab) => tab.href)).toEqual([
      "/app/mail/Box001",
      ...expectedViews.map((view) => `/app/mail/Box001?view=${view}`),
      "/app/mail/Box001?savedView=Saved1",
    ]);
    expect(tabs[1]?.count).toBe("#3");
    expect(tabs.at(-1)).toMatchObject({ label: "Invoices", icon: "ti ti-user" });
    expect(mailboxViewTabs({ ...input, assignedOnly: true }).map((tab) => tab.id)).toEqual([
      "all",
      ...expectedViews.filter((view) => view !== "unassigned"),
      "saved:Saved1",
    ]);
  });
});
