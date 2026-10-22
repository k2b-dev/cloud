import { describe, expect, test } from "bun:test";
import type { ConversationRowState } from "../../service/messages";
import { mailTestRow } from "./mail-list-test-fixtures";
import { mailRowOlderThanDetail } from "./mail-selection-detail";

const state: ConversationRowState = {
  revision: 3,
  messageCount: 101,
  activeFolderIds: ["inbox"],
  unreadFolderIds: [],
  flaggedFolderIds: [],
};
const row = mailTestRow("one", { ...state, unread: false, flagged: false });
const all = () => true;
const detail = (overrides: Partial<ConversationRowState> = {}) => ({
  conversationRowState: { ...state, ...overrides },
  collaborationState: null,
  conversationLocalTags: null,
});

describe("mailRowOlderThanDetail", () => {
  test("matches the complete state even with only 100 message bodies (#1510)", () => {
    const response = {
      ...detail({ unreadFolderIds: ["inbox"] }),
      detailMessages: Array.from({ length: 100 }, () => ({ folderId: "inbox", flags: ["\\Seen"] })),
    };
    expect(mailRowOlderThanDetail(row, response, all)).toBe(true);
    expect(mailRowOlderThanDetail(row, detail(), all)).toBe(false);
    expect(mailRowOlderThanDetail(undefined, response, all)).toBe(false);
  });

  test("detects both added and removed flags, unread state, placements and messages", () => {
    for (const change of [
      { revision: 4 },
      { messageCount: 102 },
      { messageCount: 100 },
      { activeFolderIds: ["inbox", "archive"] },
      { activeFolderIds: ["archive"] },
      { flaggedFolderIds: ["inbox"] },
      { unreadFolderIds: ["inbox"] },
    ])
      expect(mailRowOlderThanDetail(row, detail(change), all)).toBe(true);
    expect(mailRowOlderThanDetail({ ...row, flagged: true }, detail(), all)).toBe(true);
    expect(mailRowOlderThanDetail({ ...row, unread: true, unreadFolderIds: ["inbox"] }, detail(), all)).toBe(true);
  });

  test("a folder list compares all placements in its folder, regardless of the detail's chosen placement", () => {
    const response = detail({ activeFolderIds: ["archive", "inbox"], unreadFolderIds: ["archive"], flaggedFolderIds: ["archive"] });
    expect(mailRowOlderThanDetail(row, response, (id) => id === "inbox")).toBe(false);
    expect(mailRowOlderThanDetail(row, response, all)).toBe(true);
  });

  test("excluded folders do not invalidate a row", () => {
    const response = detail({ activeFolderIds: ["inbox", "trash"], unreadFolderIds: ["trash"], flaggedFolderIds: ["trash"] });
    expect(mailRowOlderThanDetail(row, response, (id) => id !== "trash")).toBe(false);
  });

  test("search folder scope restricts unread state but not active or flagged folders", () => {
    const searchRow = { ...row, activeFolderIds: ["inbox", "archive"] };
    const response = detail({ activeFolderIds: ["archive", "inbox"], unreadFolderIds: ["archive"] });
    expect(mailRowOlderThanDetail(searchRow, response, all, new Set(["inbox"]))).toBe(false);
    expect(mailRowOlderThanDetail(searchRow, response, all)).toBe(true);
    expect(
      mailRowOlderThanDetail(
        searchRow,
        detail({ ...response.conversationRowState, flaggedFolderIds: ["archive"] }),
        all,
        new Set(["inbox"]),
      ),
    ).toBe(true);
  });

  test("a failed state read requests recovery rather than certifying a stale row", () => {
    expect(mailRowOlderThanDetail(row, { ...detail(), conversationRowState: null }, all)).toBe(true);
  });
});

test("a newer revision in another detail section still invalidates the row", () => {
  expect(mailRowOlderThanDetail(row, { ...detail(), collaborationState: { revision: 4 }, conversationLocalTags: null }, all)).toBe(true);
  expect(
    mailRowOlderThanDetail(row, { ...detail(), collaborationState: null, conversationLocalTags: { conversationRevision: 4 } }, all),
  ).toBe(true);
});
