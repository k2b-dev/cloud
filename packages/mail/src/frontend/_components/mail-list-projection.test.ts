import { describe, expect, test } from "bun:test";
import type { ConversationViewCounts } from "../../service/messages";
import { mailTestFolder, mailTestRow } from "./mail-list-test-fixtures";
import { type MailListRemoval, mailListRowKey, projectMailCounts, projectMailList } from "./mail-list-projection";

const items = [mailTestRow("one"), mailTestRow("two"), mailTestRow("three")];
const removal = (index: number, phase: MailListRemoval["phase"]): MailListRemoval => ({
  rowKey: items[index]!.id,
  conversationId: items[index]!.id,
  scope: "inbox",
  item: items[index]!,
  before: items.slice(0, index).map(mailListRowKey),
  sourceFolderIds: ["inbox"],
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
const folders = [mailTestFolder("inbox"), mailTestFolder("sent")];
const counts = (overrides: Partial<Parameters<typeof projectMailCounts>[0]> = {}) =>
  projectMailCounts({
    items,
    shown: items,
    folders,
    viewCounts,
    activeView: "needs_action",
    listMode: "conversations",
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
    expect(counts({ items: [read], shown: [{ ...read, unread: true }] }).folders.map((folder) => folder.unread)).toEqual([4, 4]);
    expect(counts({ listMode: "messages", removals: [removal(0, "hidden")] }).viewCounts).toBe(viewCounts);
  });
  test("a pending read followed by a removal does not lower the same folder badge twice", () => {
    const changed = counts({ shown: [{ ...items[0]!, unread: false }, ...items.slice(1)], removals: [removal(0, "hidden")] });
    expect(changed.folders[0]?.unread).toBe(2);
  });
});
