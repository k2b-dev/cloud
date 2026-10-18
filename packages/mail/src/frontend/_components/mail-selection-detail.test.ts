import { describe, expect, test } from "bun:test";
import { mailTestRow } from "./mail-list-test-fixtures";
import { syncMailRowWithDetail } from "./mail-selection-detail";

const message = (folderId: string | null, seen: boolean) => ({ folderId, flags: seen ? ["\\Seen"] : [] });
const detail = (messages: ReturnType<typeof message>[], revision = 0) => ({
  detailMessages: messages,
  collaborationState: revision ? { revision } : null,
  conversationLocalTags: null,
});

describe("syncMailRowWithDetail", () => {
  test("keeps a row that is as new as the detail", () => {
    const row = mailTestRow("one", { unread: true, unreadFolderIds: ["inbox"], revision: 4 });
    expect(syncMailRowWithDetail(row, detail([message("inbox", false), message("inbox", true)], 4))).toBe(row);
  });

  test("takes the newer revision for actions that send it", () => {
    const row = mailTestRow("one", { unread: false, unreadFolderIds: [], revision: 2 });
    expect(syncMailRowWithDetail(row, detail([message("inbox", true)], 5))).toMatchObject({
      revision: 5,
      unread: false,
      unreadFolderIds: [],
    });
  });

  test("a read row with a newer unread message becomes unread in that message's folder", () => {
    const row = mailTestRow("one", { unread: false, unreadFolderIds: [], revision: 1 });
    expect(syncMailRowWithDetail(row, detail([message("inbox", true), message("archive", false)]))).toMatchObject({
      unread: true,
      unreadFolderIds: ["archive"],
    });
  });

  test("a row with fewer messages than the detail takes the detail's count", () => {
    const row = mailTestRow("one", { unread: false, unreadFolderIds: [], revision: 1, messageCount: 1 });
    expect(syncMailRowWithDetail(row, detail([message("inbox", true), message("inbox", true)])).messageCount).toBe(2);
  });

  test("an unread row also gains the folders of unread messages it did not know", () => {
    const row = mailTestRow("one", { unread: true, unreadFolderIds: ["inbox"], revision: 1 });
    expect(syncMailRowWithDetail(row, detail([message("inbox", false), message("archive", false)])).unreadFolderIds).toEqual([
      "inbox",
      "archive",
    ]);
  });
});
