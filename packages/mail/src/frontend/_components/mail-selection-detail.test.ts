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
    expect(mailRowOlderThanDetail(fresh, detail([message("inbox", false), message("inbox", true)], 3), all, true)).toBe(false);
    expect(mailRowOlderThanDetail(undefined, detail([message("inbox", false)], 9), all, true)).toBe(false);
  });

  test("a newer revision, more messages, a new flag or an unread message in another folder make it older", () => {
    expect(mailRowOlderThanDetail(fresh, detail([message("inbox", true)], 4), all, true)).toBe(true);
    expect(
      mailRowOlderThanDetail(fresh, detail([message("inbox", true), message("inbox", true), message("inbox", true)], 3), all, true),
    ).toBe(true);
    expect(mailRowOlderThanDetail(fresh, detail([message("inbox", true, true)], 3), all, true)).toBe(true);
    expect(mailRowOlderThanDetail(fresh, detail([message("archive", false)], 3), all, true)).toBe(true);
  });

  test("a flag or unread state no message has anymore makes a folder row older when the detail holds every message", () => {
    const flaggedRow = mailTestRow("one", { unread: false, unreadFolderIds: [], flagged: true, revision: 3, messageCount: 2 });
    expect(mailRowOlderThanDetail(flaggedRow, detail([message("inbox", true), message("inbox", true)], 3), all, true)).toBe(true);
    expect(mailRowOlderThanDetail({ ...flaggedRow, messageCount: 150 }, detail([message("inbox", true)], 3), all, true)).toBe(false);
    expect(mailRowOlderThanDetail(fresh, detail([message("inbox", true), message("inbox", true)], 3), all, true)).toBe(true);
    // Outside a folder list a message's other placements can hold the flag.
    expect(mailRowOlderThanDetail(flaggedRow, detail([message("inbox", true), message("inbox", true)], 3), all, false)).toBe(false);
  });

  test("messages in folders the list leaves out do not count", () => {
    const listed = (folderId: string | null) => folderId !== "trash";
    expect(mailRowOlderThanDetail(fresh, detail([message("trash", false, true)], 3), listed, false)).toBe(false);
  });

  test("a row whose folder holds none of the detail's messages is older, once the detail holds every message", () => {
    // The detail prefers the row's folder for each message, so no message there means the conversation left it.
    const read = mailTestRow("one", { unread: false, unreadFolderIds: [], flagged: false, revision: 3, messageCount: 2 });
    const moved = detail([message("archive", true), message("archive", true)], 3);
    expect(mailRowOlderThanDetail(read, moved, all, false)).toBe(true);
    expect(mailRowOlderThanDetail(read, detail([message("inbox", true), message("archive", true)], 3), all, false)).toBe(false);
    expect(mailRowOlderThanDetail({ ...read, messageCount: 150 }, moved, all, false)).toBe(false);
    expect(mailRowOlderThanDetail({ ...read, sourceFolderId: null }, moved, all, false)).toBe(false);
  });

  test("a search limited to folders compares unread state only for messages in those folders", () => {
    const read = mailTestRow("one", { unread: false, unreadFolderIds: [], flagged: false, revision: 3, messageCount: 2 });
    const messages = detail([message("inbox", true), message("archive", false)], 3);
    expect(mailRowOlderThanDetail(read, messages, all, false, new Set(["inbox"]))).toBe(false);
    expect(mailRowOlderThanDetail(read, messages, all, false, null)).toBe(true);
    const unreadRow = { ...read, unread: true, unreadFolderIds: ["inbox"] };
    // An unread row in one folder whose unread message there was read elsewhere is older, also next to unread mail outside.
    expect(mailRowOlderThanDetail(unreadRow, messages, all, true, new Set(["inbox"]))).toBe(true);
  });
});
