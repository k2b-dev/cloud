import { describe, expect, test } from "bun:test";
import {
  buildMailActionInput,
  getMailAction,
  MAIL_ACTION_IDS,
  type MailActionId,
  mailActionTargetForItem,
  mailMoveSourceFolderIds,
  mailRoleDestinationFolderId,
  spamActionForConversation,
} from "./mail-actions";

describe("Mail actions", () => {
  const folder = (id: string, role: string, providerRole = role, configuredRole: string | null = null) => ({
    id,
    role,
    providerRole,
    configuredRole,
    selectable: true,
    discoveryState: "active",
  });

  test("defines every action exactly once", () => {
    expect(new Set(MAIL_ACTION_IDS).size).toBe(MAIL_ACTION_IDS.length);
    for (const id of MAIL_ACTION_IDS) expect(getMailAction(id).id).toBe(id);
    expect(getMailAction("flag").icon).toBe("ti ti-flag");
  });

  test("builds provider move inputs", () => {
    expect(
      buildMailActionInput({
        actionId: "move",
        sourceFolderId: "source",
        destinationFolderId: "target",
        idempotencyKey: "idem",
        correlationId: "corr",
      }),
    ).toMatchObject({ kind: "move_to_folder", sourceFolderId: "source", destinationFolderId: "target" });
    expect(
      buildMailActionInput({
        actionId: "not_spam",
        sourceFolderId: "junk",
        idempotencyKey: "not-spam",
        correlationId: "corr",
      }),
    ).toMatchObject({ kind: "move_to_role", sourceFolderId: "junk", role: "inbox" });
  });

  test("offers Not spam only when the action would take the conversation out of Junk", () => {
    const folders = [folder("inbox", "inbox"), folder("sent", "sent"), folder("junk", "junk")];
    expect(spamActionForConversation({ viewFolderId: "junk", activeFolderIds: ["junk"], folders })).toBe("not_spam");
    expect(spamActionForConversation({ viewFolderId: "inbox", activeFolderIds: ["inbox"], folders })).toBe("junk");
    expect(spamActionForConversation({ viewFolderId: null, activeFolderIds: [], folders })).toBe("junk");
    // A view across folders, such as Needs action: the newest message in Junk next to an older reply in Sent.
    expect(spamActionForConversation({ viewFolderId: null, activeFolderIds: ["sent", "junk"], folders })).toBe("not_spam");
    expect(spamActionForConversation({ viewFolderId: null, activeFolderIds: ["inbox", "junk"], folders })).toBe("junk");
  });

  describe("take a conversation out of", () => {
    const folders = [
      folder("inbox", "inbox"),
      folder("sent", "sent"),
      folder("drafts", "drafts"),
      folder("projects", "other"),
      folder("trash", "trash"),
    ];
    const sources = (actionId: MailActionId, viewFolderId: string | null, activeFolderIds: string[], list = folders) =>
      mailMoveSourceFolderIds({ actionId, viewFolderId, activeFolderIds, folders: list });

    test("the folder in view, even when the newest reply sits in Sent", () => {
      expect(sources("archive", "inbox", ["inbox", "sent"])).toEqual(["inbox"]);
      expect(sources("archive", "sent", ["inbox", "sent"])).toEqual(["sent"]);
    });

    test("every ordinary folder when the view spans folders, without the copies in Sent or Trash", () => {
      expect(sources("archive", null, ["sent", "inbox", "trash"])).toEqual(["inbox"]);
      expect(sources("archive", null, ["inbox", "projects", "drafts"])).toEqual(["inbox", "projects"]);
    });

    test("Trash, then Sent, when the conversation lives only there", () => {
      expect(sources("archive", null, ["sent", "trash"])).toEqual(["trash"]);
      expect(sources("archive", null, ["sent"])).toEqual(["sent"]);
    });

    test("the conversation's own folders when a search result is not in the folder in view", () => {
      expect(sources("archive", "inbox", ["projects", "sent"])).toEqual(["projects"]);
    });

    describe("on Gmail, where labels are folders and one move changes the message everywhere", () => {
      const gmail = [
        folder("inbox", "inbox"),
        folder("sent", "sent"),
        folder("important", "other"),
        folder("starred", "other"),
        folder("work", "other"),
        folder("spam", "junk"),
        folder("trash", "trash"),
        folder("all-mail", "all"),
      ];
      const labelled = ["inbox", "important", "starred", "work", "all-mail", "sent"];

      test("Archive in a view that spans folders only leaves the Inbox and keeps every other label", () => {
        expect(sources("archive", null, labelled, gmail)).toEqual(["inbox"]);
        expect(sources("archive", null, ["work", "starred", "all-mail"], gmail)).toEqual([]);
      });

      test("Delete, Spam, and Move act once, from the Inbox when the conversation is there", () => {
        expect(sources("trash", null, labelled, gmail)).toEqual(["inbox"]);
        expect(sources("junk", null, labelled, gmail)).toEqual(["inbox"]);
        expect(sources("move", null, labelled, gmail)).toEqual(["inbox"]);
        expect(sources("trash", null, ["work", "important", "all-mail"], gmail)).toEqual(["work"]);
      });

      test("Spam, Trash, and All Mail as before when the conversation lives only there", () => {
        expect(sources("archive", null, ["sent", "all-mail"], gmail)).toEqual(["all-mail"]);
        expect(sources("trash", null, ["spam"], gmail)).toEqual(["spam"]);
        expect(spamActionForConversation({ viewFolderId: null, activeFolderIds: ["spam"], folders: gmail })).toBe("not_spam");
      });

      test("the label in view, like any folder", () => {
        expect(sources("archive", "work", labelled, gmail)).toEqual(["work"]);
      });
    });
  });

  test("finds the folder an action moves to the way the server does", () => {
    const gmail = [folder("inbox", "inbox"), folder("all-mail", "all"), folder("trash", "trash")];
    expect(mailRoleDestinationFolderId("archive", gmail)).toBe("all-mail");
    expect(mailRoleDestinationFolderId("not_spam", gmail)).toBe("inbox");
    expect(mailRoleDestinationFolderId("junk", gmail)).toBeNull();
    expect(mailRoleDestinationFolderId("move", gmail)).toBeNull();

    const ambiguous = [folder("archive-a", "archive"), folder("archive-b", "archive")];
    expect(mailRoleDestinationFolderId("archive", ambiguous)).toBeNull();
    expect(mailRoleDestinationFolderId("archive", [...ambiguous, folder("chosen", "archive", "other", "archive")])).toBe("chosen");
    expect(
      mailRoleDestinationFolderId("archive", [...ambiguous.slice(0, 1), { ...folder("gone", "archive"), discoveryState: "missing" }]),
    ).toBe("archive-a");

    // Like the server, a provider Archive folder configured as Junk still claims Archive by its provider role.
    const reassigned = [folder("provider-archive", "junk", "archive", "junk"), folder("all-mail", "all")];
    expect(mailRoleDestinationFolderId("archive", reassigned)).toBe("provider-archive");
    expect(mailRoleDestinationFolderId("junk", reassigned)).toBe("provider-archive");
  });

  test("acts on the message of a message-list row, not on the rest of its conversation", () => {
    const folders = [folder("inbox", "inbox"), folder("archive", "archive")];
    const row = {
      id: "message-a",
      conversationId: "conversation-1",
      selectionKind: "message" as const,
      subject: "Invoice",
      unreadFolderIds: ["inbox"],
      activeFolderIds: ["inbox"],
    };
    const target = (item: typeof row | (Omit<typeof row, "selectionKind"> & { selectionKind: "conversation" }), actionId: MailActionId) =>
      mailActionTargetForItem({ item, actionId, viewFolderId: "inbox", folders, noSubject: "(no subject)" });

    for (const actionId of ["trash", "move", "mark_read", "flag"] satisfies MailActionId[]) {
      expect(target(row, actionId)).toEqual({
        conversationId: "conversation-1",
        label: "Invoice",
        sourceFolderIds: ["inbox"],
        messageIds: ["message-a"],
      });
    }
    expect(target({ ...row, id: "conversation-1", selectionKind: "conversation" }, "trash")).toEqual({
      conversationId: "conversation-1",
      label: "Invoice",
      sourceFolderIds: ["inbox"],
    });
    expect(
      buildMailActionInput({
        actionId: "trash",
        sourceFolderId: "inbox",
        messageIds: ["message-a"],
        idempotencyKey: "i",
        correlationId: "c",
      }),
    ).toMatchObject({ kind: "move_to_role", messageIds: ["message-a"] });
  });
});
