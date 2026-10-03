import { describe, expect, test } from "bun:test";
import { DEFAULT_MAIL_CONVERSATION_TOOLBAR_ACTIONS } from "./mail-conversation-toolbar";
import { mailWorkspaceCookie, readMailWorkspacePreferences, updateMailWorkspacePreferences } from "./mail-workspace-preferences";

describe("Mail workspace preferences", () => {
  test("reads the list layout preference", () => {
    const value = encodeURIComponent(
      JSON.stringify({ listCollapsed: true, detailsOpen: true, toolbarActions: ["tags", "reply", "archive"] }),
    );
    expect(readMailWorkspacePreferences(`cloud_mail_workspace=${value}`)).toEqual({
      listCollapsed: true,
      detailsOpen: true,
      toolbarActions: ["reply", "archive", "tags"],
      listMode: "conversations",
      lastMailboxId: null,
      pinnedMailboxIds: [],
      hiddenMailboxIds: [],
    });
  });

  test("keeps an intentionally empty toolbar", () => {
    const value = encodeURIComponent(JSON.stringify({ toolbarActions: [] }));
    expect(readMailWorkspacePreferences(`cloud_mail_workspace=${value}`).toolbarActions).toEqual([]);
  });

  test("ignores invalid and removed preferences", () => {
    const value = encodeURIComponent(JSON.stringify({ listCollapsed: false, shortcutOverrides: { archive: "e" } }));
    expect(readMailWorkspacePreferences(`cloud_mail_workspace=${value}`)).toEqual({
      listCollapsed: false,
      detailsOpen: false,
      toolbarActions: DEFAULT_MAIL_CONVERSATION_TOOLBAR_ACTIONS,
      listMode: "conversations",
      lastMailboxId: null,
      pinnedMailboxIds: [],
      hiddenMailboxIds: [],
    });
    expect(readMailWorkspacePreferences("cloud_mail_workspace=%7Bbroken")).toEqual({
      listCollapsed: false,
      detailsOpen: false,
      toolbarActions: DEFAULT_MAIL_CONVERSATION_TOOLBAR_ACTIONS,
      listMode: "conversations",
      lastMailboxId: null,
      pinnedMailboxIds: [],
      hiddenMailboxIds: [],
    });
  });

  test("reads the optional message list mode", () => {
    const value = encodeURIComponent(JSON.stringify({ listMode: "messages" }));
    expect(readMailWorkspacePreferences(`cloud_mail_workspace=${value}`).listMode).toBe("messages");
  });

  test("reads the last opened mailbox id", () => {
    const value = encodeURIComponent(JSON.stringify({ lastMailboxId: "Box001" }));
    expect(readMailWorkspacePreferences(`cloud_mail_workspace=${value}`).lastMailboxId).toBe("Box001");
  });

  test("drops storage-backed UUID mailbox identities", () => {
    const value = encodeURIComponent(JSON.stringify({ lastMailboxId: "00000000-0000-4000-8000-000000000002" }));
    expect(readMailWorkspacePreferences(`cloud_mail_workspace=${value}`).lastMailboxId).toBeNull();
  });

  test("keeps unique public mailbox IDs in pin order", () => {
    const value = encodeURIComponent(
      JSON.stringify({ pinnedMailboxIds: ["Box002", "invalid", "Box001", "Box002", "00000000-0000-4000-8000-000000000002"] }),
    );
    expect(readMailWorkspacePreferences(`cloud_mail_workspace=${value}`).pinnedMailboxIds).toEqual(["Box002", "Box001"]);
  });

  test("keeps unique public IDs of hidden mailboxes", () => {
    const value = encodeURIComponent(JSON.stringify({ hiddenMailboxIds: ["Box003", "Box003", "not a mailbox", 7] }));
    expect(readMailWorkspacePreferences(`cloud_mail_workspace=${value}`).hiddenMailboxIds).toEqual(["Box003"]);
  });

  test("keeps the lists a browser stored before pins moved to the person until the overview imports them", () => {
    const previousDocument = globalThis.document;
    const cookieJar = { cookie: "" };
    Object.defineProperty(globalThis, "document", { value: cookieJar, configurable: true });
    try {
      cookieJar.cookie = `cloud_mail_workspace=${encodeURIComponent(
        JSON.stringify({ listMode: "messages", pinnedMailboxIds: ["Box002"], hiddenMailboxIds: ["Box003"] }),
      )}`;
      // Opening a mailbox before the overview must not lose them.
      updateMailWorkspacePreferences({ lastMailboxId: "Box001" });
      const stored = readMailWorkspacePreferences(cookieJar.cookie);
      expect(stored).toMatchObject({ pinnedMailboxIds: ["Box002"], hiddenMailboxIds: ["Box003"], lastMailboxId: "Box001" });

      // The overview's Set-Cookie drops the imported lists and keeps every other preference.
      const header = mailWorkspaceCookie({ ...stored, pinnedMailboxIds: [], hiddenMailboxIds: [] });
      expect(header).toEndWith("; Path=/app/mail; Max-Age=31536000; SameSite=Lax");
      expect(readMailWorkspacePreferences(header.split(";")[0])).toEqual({
        ...stored,
        pinnedMailboxIds: [],
        hiddenMailboxIds: [],
      });
    } finally {
      Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    }
  });

  test("an older document changes only the preference it writes", () => {
    const previousDocument = globalThis.document;
    // The browser keeps one cookie value per name; a stub is enough to model it.
    const cookieJar = { cookie: "" };
    Object.defineProperty(globalThis, "document", { value: cookieJar, configurable: true });
    try {
      // A newer document already switched back to conversations and pinned a mailbox.
      cookieJar.cookie = `cloud_mail_workspace=${encodeURIComponent(
        JSON.stringify({ listMode: "conversations", pinnedMailboxIds: ["Box002"], lastMailboxId: "Box002" }),
      )}`;
      // The old document rendered with message view and no pins records only its mailbox.
      updateMailWorkspacePreferences({ lastMailboxId: "Box001" });
      expect(readMailWorkspacePreferences(cookieJar.cookie)).toMatchObject({
        listMode: "conversations",
        pinnedMailboxIds: ["Box002"],
        lastMailboxId: "Box001",
      });
    } finally {
      Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    }
  });
});
