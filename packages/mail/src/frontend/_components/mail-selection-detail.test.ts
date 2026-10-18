import { describe, expect, test } from "bun:test";
import { mailTestRow } from "./mail-list-test-fixtures";
import { mailRowOlderThanDetail } from "./mail-selection-detail";

const message = (folderId: string | null, seen: boolean, flagged = false) => ({
  folderId,
  flags: [...(seen ? ["\\Seen"] : []), ...(flagged ? ["\\Flagged"] : [])],
});
const detail = (messages: ReturnType<typeof message>[], revision: number) => ({
  detailMessages: messages,
  collaborationState: { revision },
  conversationLocalTags: null,
});

describe("mailRowOlderThanDetail", () => {
  const all = () => true;
  const fresh = mailTestRow("one", { unread: true, unreadFolderIds: ["inbox"], flagged: false, revision: 3, messageCount: 2 });

  test("a row that matches its detail is not older", () => {
    expect(mailRowOlderThanDetail(fresh, detail([message("inbox", false), message("inbox", true)], 3), all)).toBe(false);
    expect(mailRowOlderThanDetail(undefined, detail([message("inbox", false)], 9), all)).toBe(false);
  });

  test("a newer revision, more messages, a new flag or an unread message in another folder make it older", () => {
    expect(mailRowOlderThanDetail(fresh, detail([message("inbox", true)], 4), all)).toBe(true);
    expect(mailRowOlderThanDetail(fresh, detail([message("inbox", true), message("inbox", true), message("inbox", true)], 3), all)).toBe(
      true,
    );
    expect(mailRowOlderThanDetail(fresh, detail([message("inbox", true, true)], 3), all)).toBe(true);
    expect(mailRowOlderThanDetail(fresh, detail([message("archive", false)], 3), all)).toBe(true);
  });

  test("messages in folders the list leaves out do not count", () => {
    const listed = (folderId: string | null) => folderId !== "trash";
    expect(mailRowOlderThanDetail(fresh, detail([message("trash", false, true)], 3), listed)).toBe(false);
  });
});
