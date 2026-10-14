import { describe, expect, test } from "bun:test";
import {
  type MailListingScope,
  mailListingExcludesTrashAndJunk,
  mailPlacementsBelongInListing,
  mailRowLeavesListing,
} from "./folder-display-rules";
import { mailTestFolder, mailTestRow } from "./frontend/_components/mail-list-test-fixtures";

const scope: MailListingScope = { viewFolderId: null, activeView: null, hasSearch: false, hasSavedView: false, scheduledMode: false };
const folders = [
  mailTestFolder("inbox"),
  mailTestFolder("trash", { displayNeutral: true }),
  mailTestFolder("junk", { displayNeutral: true }),
  mailTestFolder("sent", { displayNeutral: true }),
  mailTestFolder("archive"),
  mailTestFolder("private", { effectiveDisplay: "folder_only" }),
];
const leaves = (overrides: Partial<Parameters<typeof mailRowLeavesListing>[0]> = {}) =>
  mailRowLeavesListing({
    ...scope,
    item: mailTestRow("one"),
    folders,
    sourceFolderIds: ["inbox"],
    destinationFolderId: "trash",
    ...overrides,
  });
describe("Mail row listing membership after a move", () => {
  test("an open folder loses only a row moved out of that folder, even with an unknown destination", () => {
    expect(leaves({ viewFolderId: "inbox", destinationFolderId: null })).toBe(true);
    expect(leaves({ viewFolderId: "sent" })).toBe(false);
  });
  test("All mail Delete leaves without a Sent copy and stays with one", () => {
    expect(leaves()).toBe(true);
    expect(leaves({ item: mailTestRow("one", { activeFolderIds: ["inbox", "sent"] }) })).toBe(false);
    expect(leaves({ destinationFolderId: null })).toBe(false);
    expect(leaves({ destinationFolderId: "unknown" })).toBe(false);
  });
  test("Needs action Archive stays; Delete leaves; search and saved views retain moved mail", () => {
    expect(leaves({ activeView: "needs_action", destinationFolderId: "archive" })).toBe(false);
    expect(leaves({ activeView: "needs_action" })).toBe(true);
    expect(leaves({ hasSearch: true })).toBe(false);
    expect(leaves({ hasSavedView: true })).toBe(false);
    expect(mailListingExcludesTrashAndJunk({ ...scope, activeView: "mine" })).toBe(true);
  });
  test("aggregated display rules respect neutral copies; search finds isolated folders", () => {
    expect(leaves({ destinationFolderId: "private", item: mailTestRow("one", { activeFolderIds: ["inbox", "sent"] }) })).toBe(true);
    expect(leaves({ destinationFolderId: "private", hasSearch: true })).toBe(false);
    expect(leaves({ destinationFolderId: "private", activeView: "mine" })).toBe(false);
  });
  test("message rows decide on their own folders", () => {
    expect(leaves({ item: mailTestRow("message", { conversationId: "one", selectionKind: "message" }) })).toBe(true);
    expect(
      leaves({
        item: mailTestRow("message", { conversationId: "one", selectionKind: "message", activeFolderIds: ["sent"] }),
        sourceFolderIds: ["sent"],
      }),
    ).toBe(true);
  });
  test("known placement membership matches the move rules and leaves unknown or empty sets undecided", () => {
    const belongs = (activeFolderIds: string[], activeView: MailListingScope["activeView"] = "needs_action") =>
      mailPlacementsBelongInListing({ ...scope, activeView, folders, activeFolderIds });
    expect(belongs([])).toBeNull();
    expect(belongs(["unknown"])).toBeNull();
    expect(belongs(["inbox", "unknown"])).toBeNull();
    expect(belongs(["inbox"])).toBe(true);
    expect(belongs(["trash"])).toBe(false);
    expect(belongs(["private", "sent"])).toBe(false);
    expect(belongs(["private", "inbox"])).toBe(true);
    expect(belongs(["private"], "mine")).toBe(true);
    expect(belongs(["trash"], "recently_active")).toBe(true);
  });
});
