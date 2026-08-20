import { describe, expect, test } from "bun:test";
import { DEFAULT_MAIL_CONVERSATION_TOOLBAR_ACTIONS } from "./mail-conversation-toolbar";
import { readMailWorkspacePreferences } from "./mail-workspace-preferences";

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
    });
    expect(readMailWorkspacePreferences("cloud_mail_workspace=%7Bbroken")).toEqual({
      listCollapsed: false,
      detailsOpen: false,
      toolbarActions: DEFAULT_MAIL_CONVERSATION_TOOLBAR_ACTIONS,
      listMode: "conversations",
      lastMailboxId: null,
      pinnedMailboxIds: [],
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
});
