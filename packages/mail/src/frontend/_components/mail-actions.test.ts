import { describe, expect, test } from "bun:test";
import {
  buildMailActionInput,
  getMailAction,
  MAIL_ACTION_IDS,
  mailMoveSourceFolderIds,
  mailRoleDestinationFolderId,
  spamActionForFolder,
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

  test("uses not-spam only for messages currently shown from junk", () => {
    expect(spamActionForFolder("junk-folder", ["junk-folder"])).toBe("not_spam");
    expect(spamActionForFolder("inbox-folder", ["junk-folder"])).toBe("junk");
    expect(spamActionForFolder(null, ["junk-folder"])).toBe("junk");
  });

  describe("take a conversation out of", () => {
    const folders = [
      folder("inbox", "inbox"),
      folder("sent", "sent"),
      folder("drafts", "drafts"),
      folder("projects", "other"),
      folder("trash", "trash"),
      folder("all-mail", "all"),
    ];

    test("the folder in view, even when the newest reply sits in Sent", () => {
      expect(mailMoveSourceFolderIds({ viewFolderId: "inbox", activeFolderIds: ["inbox", "sent"], folders })).toEqual(["inbox"]);
      expect(mailMoveSourceFolderIds({ viewFolderId: "sent", activeFolderIds: ["inbox", "sent"], folders })).toEqual(["sent"]);
    });

    test("every ordinary folder when the view spans folders, without the copies in Sent, Trash, or All Mail", () => {
      expect(mailMoveSourceFolderIds({ viewFolderId: null, activeFolderIds: ["sent", "inbox", "all-mail", "trash"], folders })).toEqual([
        "inbox",
      ]);
      expect(mailMoveSourceFolderIds({ viewFolderId: null, activeFolderIds: ["inbox", "projects", "drafts"], folders })).toEqual([
        "inbox",
        "projects",
      ]);
    });

    test("Trash, then All Mail, then Sent, when the conversation lives only there", () => {
      expect(mailMoveSourceFolderIds({ viewFolderId: null, activeFolderIds: ["sent", "trash", "all-mail"], folders })).toEqual(["trash"]);
      expect(mailMoveSourceFolderIds({ viewFolderId: null, activeFolderIds: ["sent", "all-mail"], folders })).toEqual(["all-mail"]);
      expect(mailMoveSourceFolderIds({ viewFolderId: null, activeFolderIds: ["sent"], folders })).toEqual(["sent"]);
    });

    test("the conversation's own folders when a search result is not in the folder in view", () => {
      expect(mailMoveSourceFolderIds({ viewFolderId: "inbox", activeFolderIds: ["projects", "sent"], folders })).toEqual(["projects"]);
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
});
