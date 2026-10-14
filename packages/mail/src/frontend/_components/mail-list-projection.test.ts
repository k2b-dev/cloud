import { describe, expect, test } from "bun:test";
import type { ConversationViewCounts } from "../../service/messages";
import { type MailListRemoval, mailListRowKey, mailRemovalCoversRow, projectMailCounts, projectMailList } from "./mail-list-projection";
import { mailTestFolder, mailTestRow } from "./mail-list-test-fixtures";

const items = [mailTestRow("one"), mailTestRow("two"), mailTestRow("three")];
const removal = (index: number, phase: MailListRemoval["phase"]): MailListRemoval => ({
  rowKey: items[index]!.id,
  conversationId: items[index]!.id,
  scope: "inbox",
  item: items[index]!,
  before: items.slice(0, index).map(mailListRowKey),
  sourceFolderIds: ["inbox"],
  destinationFolderId: "trash",
  phase,
});
const viewCounts: ConversationViewCounts = {
  needs_action: 3,
  mine: 0,
  unassigned: 0,
  waiting: 0,
  done: 0,
  snoozed: 0,
  send_problems: 0,
  recently_active: 0,
  kept: 0,
};
const folders = [
  mailTestFolder("inbox"),
  mailTestFolder("sent", { displayNeutral: true }),
  mailTestFolder("trash", { displayNeutral: true }),
  mailTestFolder("archive"),
  mailTestFolder("private", { effectiveDisplay: "folder_only" }),
];
const counts = (overrides: Partial<Parameters<typeof projectMailCounts>[0]> = {}) =>
  projectMailCounts({
    items,
    shown: items,
    folders,
    viewCounts,
    activeView: "needs_action",
    listMode: "conversations",
    now: Date.parse("2026-10-14T10:00:00.000Z"),
    currentUserId: "user",
    removals: [],
    scope: "inbox",
    ...overrides,
  });

describe("Mail list projection", () => {
  test("leaving stays inert in place; hidden filters only its scope and keeps other row identities", () => {
    const leaving = projectMailList({ items, removals: [removal(1, "leaving")], scope: "inbox" });
    expect(leaving.items).toEqual(items);
    expect([...leaving.leavingKeys]).toEqual(["two"]);
    const hidden = projectMailList({ items, removals: [removal(1, "hidden")], scope: "inbox" });
    expect(hidden.items).toEqual([items[0]!, items[2]!]);
    expect(hidden.items[0]).toBe(items[0]);
    expect(projectMailList({ items, removals: [removal(1, "hidden")], scope: "search" }).items).toEqual(items);
  });
  test("held rows return after the nearest surviving predecessor, once, in original bulk order", () => {
    expect(projectMailList({ items: [items[0]!], removals: [removal(1, "held"), removal(2, "held")], scope: "inbox" }).items).toEqual(
      items,
    );
    expect(projectMailList({ items, removals: [removal(1, "held")], scope: "inbox" }).items[1]).toBe(items[1]);
    expect(projectMailList({ items: [items[2]!], removals: [removal(1, "held")], scope: "inbox" }).items).toEqual([items[1]!, items[2]!]);
  });
  test("message rows have independent keys within one conversation", () => {
    const a = mailTestRow("a", { selectionKind: "message", conversationId: "one" });
    const b = mailTestRow("b", { selectionKind: "message", conversationId: "one" });
    expect(mailListRowKey(a)).toBe("message:a");
    expect(
      projectMailList({ items: [a, b], removals: [{ ...removal(0, "hidden"), rowKey: mailListRowKey(a), item: a }], scope: "inbox" }).items,
    ).toEqual([b]);
  });
  test("counts lower only until the snapshot removed the row; held mirrors that, scoped and deduplicated", () => {
    const pending = counts({ removals: [removal(1, "leaving"), removal(1, "hidden")] });
    expect(pending.folders[0]?.unread).toBe(2);
    expect(pending.folders[1]).toBe(folders[1]);
    expect(pending.viewCounts.needs_action).toBe(2);
    expect(counts({ items: [items[0]!, items[2]!], removals: [removal(1, "hidden")] }).folders).toBe(folders);
    expect(counts({ items: [items[0]!, items[2]!], removals: [removal(1, "held")] }).viewCounts.needs_action).toBe(4);
    expect(counts({ removals: [removal(1, "hidden")], scope: "search" }).viewCounts).toBe(viewCounts);
  });
  test("read and unread patches change only the submitted folders; clamps and preserves unchanged inputs", () => {
    expect(counts().folders).toBe(folders);
    expect(counts().viewCounts).toBe(viewCounts);
    expect(counts({ shown: items.map((item) => ({ ...item, unread: false })) }).folders[0]?.unread).toBe(0);
    const read = mailTestRow("read", { unread: false, unreadFolderIds: [], activeFolderIds: ["inbox", "sent"] });
    expect(
      counts({ items: [read], shown: [{ ...read, unread: true }] })
        .folders.slice(0, 2)
        .map((folder) => folder.unread),
    ).toEqual([4, 4]);
    expect(counts({ listMode: "messages", removals: [removal(0, "hidden")] }).viewCounts).toBe(viewCounts);
  });
  test("a pending read followed by a removal does not lower the same folder badge twice", () => {
    const changed = counts({ shown: [{ ...items[0]!, unread: false }, ...items.slice(1)], removals: [removal(0, "hidden")] });
    expect(changed.folders[0]?.unread).toBe(2);
  });
  test("a new message escapes pending removal in both phases and receives no removal count delta", () => {
    const next = { ...items[0]!, latestMessageAt: "2026-10-04T10:00:00.000Z", revision: 2 };
    for (const phase of ["hidden", "leaving", "held"] as const) {
      const pending = removal(0, phase);
      expect(mailRemovalCoversRow(pending, next)).toBe(false);
      const projected = projectMailList({ items: [next], removals: [pending], scope: "inbox" });
      expect(projected.items).toEqual([next]);
      expect(projected.leavingKeys.size).toBe(0);
      const result = counts({ items: [next], shown: [next], removals: [pending] });
      expect(result.folders).toBe(folders);
      expect(result.viewCounts).toBe(viewCounts);
    }
    expect(mailRemovalCoversRow(removal(0, "hidden"), { ...items[0]!, revision: 100 })).toBe(true);
    expect(mailRemovalCoversRow(removal(0, "hidden"), { ...next, selectionKind: "message" })).toBe(true);
  });
  test("Inbox Delete adjusts only proven work views, preserving Recently active's Trash membership", () => {
    const before = {
      ...viewCounts,
      needs_action: 3,
      unassigned: 3,
      waiting: 3,
      done: 3,
      mine: 3,
      recently_active: 3,
      kept: 3,
      send_problems: 3,
    };
    expect(counts({ activeView: null, viewCounts: before, removals: [removal(0, "hidden")] }).viewCounts).toEqual({
      ...before,
      needs_action: 2,
      unassigned: 2,
    });
    expect(counts({ activeView: "needs_action", viewCounts: before, removals: [removal(0, "hidden")] }).viewCounts.needs_action).toBe(2);
    expect(
      counts({ activeView: null, viewCounts: before, removals: [removal(0, "hidden"), removal(0, "hidden")] }).viewCounts.unassigned,
    ).toBe(2);
  });
  test("archiving to an Everywhere folder preserves all work view counts", () => {
    expect(counts({ activeView: null, removals: [{ ...removal(0, "hidden"), destinationFolderId: "archive" }] }).viewCounts).toBe(
      viewCounts,
    );
  });
  test("snoozed removal lowers Later only for Trash, and Recently active too for an isolated folder", () => {
    const row = { ...items[0]!, snoozedUntil: "2026-10-15T10:00:00.000Z" };
    const before = { ...viewCounts, snoozed: 3, recently_active: 3, needs_action: 3, unassigned: 3 };
    const pending = { ...removal(0, "hidden"), item: row };
    expect(counts({ activeView: null, items: [row], shown: [row], viewCounts: before, removals: [pending] }).viewCounts).toEqual({
      ...before,
      snoozed: 2,
    });
    expect(
      counts({
        activeView: null,
        items: [row],
        shown: [row],
        viewCounts: before,
        removals: [{ ...pending, destinationFolderId: "private" }],
      }).viewCounts,
    ).toEqual({ ...before, snoozed: 2, recently_active: 2 });
  });
  test("Undo-held missing rows add proven work view counts back, once per conversation", () => {
    const before = { ...viewCounts, needs_action: 2, unassigned: 2, recently_active: 2 };
    expect(
      counts({
        activeView: null,
        items: [],
        shown: [],
        viewCounts: before,
        removals: [{ ...removal(0, "held"), destinationFolderId: "private" }],
      }).viewCounts,
    ).toEqual({ ...before, needs_action: 3, unassigned: 3, recently_active: 3 });
  });
  test("unknown and empty placements, unknown destinations and extra visible copies do not infer work deltas", () => {
    for (const activeFolderIds of [[], ["unknown"], ["inbox", "sent"]]) {
      const row = { ...items[0]!, activeFolderIds };
      expect(counts({ activeView: null, items: [row], shown: [row], removals: [{ ...removal(0, "hidden"), item: row }] }).viewCounts).toBe(
        viewCounts,
      );
    }
    for (const destinationFolderId of [null, "unknown"]) {
      expect(counts({ activeView: null, removals: [{ ...removal(0, "hidden"), destinationFolderId }] }).viewCounts).toBe(viewCounts);
    }
  });
  test("status, assignment and snooze expiry agree with work view predicates", () => {
    const before = { ...viewCounts, needs_action: 5, waiting: 5, mine: 5, unassigned: 5, done: 5, snoozed: 5, recently_active: 5 };
    for (const [overrides, changed] of [
      [{ workStatus: "waiting", assigneeUserIds: ["user"] }, ["waiting", "mine", "recently_active"]],
      [{ workStatus: "done", assigneeUserIds: ["user"] }, ["done", "recently_active"]],
      [{ workStatus: null }, ["recently_active"]],
      [{ snoozedUntil: "2026-10-13T10:00:00.000Z" }, ["needs_action", "unassigned", "recently_active"]],
    ] satisfies [Partial<(typeof items)[number]>, string[]][]) {
      const row = { ...items[0]!, ...overrides };
      const result = counts({
        activeView: null,
        items: [row],
        shown: [row],
        viewCounts: before,
        removals: [{ ...removal(0, "hidden"), item: row, destinationFolderId: "private" }],
      });
      // Mine keeps isolated folders; unlike the aggregated work views, assignment alone includes the copy.
      const expected = { ...before };
      for (const view of ["needs_action", "waiting", "mine", "unassigned", "done", "snoozed", "recently_active"] as const) {
        if (changed.includes(view) && view !== "mine") expected[view] -= 1;
      }
      expect(result.viewCounts).toEqual(expected);
    }
    const assigned = { ...items[0]!, assigneeUserIds: ["user"] };
    expect(
      counts({
        activeView: null,
        items: [assigned],
        shown: [assigned],
        viewCounts: before,
        removals: [{ ...removal(0, "hidden"), item: assigned }],
      }).viewCounts.mine,
    ).toBe(4);
  });
});
