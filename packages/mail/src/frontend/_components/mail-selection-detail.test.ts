import { describe, expect, test } from "bun:test";
import { mailTestRow } from "./mail-list-test-fixtures";
import { mailRowOlderThanDetail, syncMailRowWithDetail } from "./mail-selection-detail";

const message = (folderId: string | null, seen: boolean) => ({ folderId, flags: seen ? ["\\Seen"] : [] });
const detail = (messages: ReturnType<typeof message>[]) => ({ detailMessages: messages });

describe("syncMailRowWithDetail", () => {
  test("keeps a row that is as new as the detail", () => {
    const row = mailTestRow("one", { unread: true, unreadFolderIds: ["inbox"], messageCount: 2 });
    expect(syncMailRowWithDetail(row, detail([message("inbox", false), message("inbox", true)]))).toBe(row);
  });

  test("a read row with a newer unread message becomes unread in that message's folder", () => {
    const row = mailTestRow("one", { unread: false, unreadFolderIds: [], messageCount: 2 });
    expect(syncMailRowWithDetail(row, detail([message("inbox", true), message("archive", false)]))).toMatchObject({
      unread: true,
      unreadFolderIds: ["archive"],
    });
  });

  test("an unread row also gains the folders of unread messages it did not know", () => {
    const row = mailTestRow("one", { unread: true, unreadFolderIds: ["inbox"], messageCount: 2 });
    expect(syncMailRowWithDetail(row, detail([message("inbox", false), message("archive", false)])).unreadFolderIds).toEqual([
      "inbox",
      "archive",
    ]);
  });

  test("a row with fewer messages than the detail takes the detail's count, and never its revision", () => {
    const row = mailTestRow("one", { unread: false, unreadFolderIds: [], revision: 1, messageCount: 1 });
    expect(syncMailRowWithDetail(row, detail([message("inbox", true), message("inbox", true)]))).toMatchObject({
      messageCount: 2,
      revision: 1,
    });
  });
});

describe("mailRowOlderThanDetail", () => {
  test("compares the row revision with the collaboration and tag revisions of the detail", () => {
    const row = { revision: 3 };
    expect(mailRowOlderThanDetail(row, { collaborationState: { revision: 3 }, conversationLocalTags: { conversationRevision: 3 } })).toBe(
      false,
    );
    expect(mailRowOlderThanDetail(row, { collaborationState: { revision: 4 }, conversationLocalTags: null })).toBe(true);
    expect(mailRowOlderThanDetail(row, { collaborationState: null, conversationLocalTags: { conversationRevision: 5 } })).toBe(true);
    expect(mailRowOlderThanDetail(undefined, { collaborationState: { revision: 9 }, conversationLocalTags: null })).toBe(false);
  });
});
