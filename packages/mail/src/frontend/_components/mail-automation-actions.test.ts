import { describe, expect, test } from "bun:test";
import type { MailAutomationAction } from "../../contracts";
import type { MailWorkflowCatalogSnapshot } from "../../workflows/catalog";
import {
  createMailAutomationAction,
  mailAutomationActionKindsFor,
  mailAutomationDestinationFolders,
  mailAutomationDestinationOptions,
} from "./mail-automation-actions";

const catalog: MailWorkflowCatalogSnapshot = {
  folders: [
    { id: "00000000-0000-4000-8000-000000000001", name: "Inbox", role: "inbox" },
    { id: "00000000-0000-4000-8000-000000000002", name: "Junk", role: "junk" },
  ],
  assignableUsers: [{ id: "00000000-0000-4000-8000-000000000003", name: "Ada" }],
  localTags: [{ id: "00000000-0000-4000-8000-000000000004", name: "Customer", color: "#2563eb" }],
};

describe("mail automation action editor model", () => {
  test("destination folders show localized standard names, also as parents, beside the server's path", () => {
    const folders: MailWorkflowCatalogSnapshot["folders"] = [
      { id: "Fold01", name: "INBOX", path: "INBOX", role: "inbox" },
      { id: "Fold02", name: "Projects", path: "INBOX / Projects", role: "other" },
      { id: "Fold03", name: "Sent Items", path: "Sent Items", role: "sent" },
      { id: "Fold04", name: "Rechnungen gesendet", path: "Rechnungen gesendet" },
      { id: "Fold05", name: "Deleted Items", path: "Deleted Items", role: "trash" },
    ];
    expect(mailAutomationDestinationOptions({ ...catalog, folders }, "de")).toEqual([
      { id: "Fold01", label: "Eingang", description: "INBOX" },
      { id: "Fold02", label: "Eingang / Projects", description: "INBOX / Projects" },
      { id: "Fold03", label: "Gesendet", description: "Sent Items" },
      { id: "Fold04", label: "Rechnungen gesendet" },
    ]);
  });

  test("offers one placement after mark as read and composable collaboration actions", () => {
    const actions: MailAutomationAction[] = [{ kind: "mark_read" }];
    expect(mailAutomationActionKindsFor({ actions, catalog })).toEqual([
      "junk",
      "trash",
      "move_to_folder",
      "add_local_tag",
      "assign_user",
      "set_status",
    ]);
    expect(mailAutomationActionKindsFor({ actions, catalog, index: 0 })).toContain("move_to_folder");
    expect(mailAutomationActionKindsFor({ actions: [], catalog })).not.toContain("add_keyword");
  });

  test("offers no provider action after the message was moved", () => {
    const actions: MailAutomationAction[] = [{ kind: "move_to_folder", folderId: catalog.folders[0]!.id }];
    expect(mailAutomationActionKindsFor({ actions, catalog })).toEqual(["add_local_tag", "assign_user", "set_status"]);
  });

  test("keeps a step before a move from becoming a second move", () => {
    const actions: MailAutomationAction[] = [{ kind: "mark_read" }];
    const later: MailAutomationAction[] = [{ kind: "move_to_folder", folderId: catalog.folders[0]!.id }];
    const kinds = mailAutomationActionKindsFor({ actions, catalog, index: 0, later });
    expect(kinds).toContain("mark_read");
    expect(kinds).not.toContain("move_to_folder");
    expect(kinds).not.toContain("junk");
  });

  test("preserves an existing provider keyword action without offering a new one", () => {
    const actions: MailAutomationAction[] = [{ kind: "add_keyword", keyword: "Legacy" }];
    expect(mailAutomationActionKindsFor({ actions, catalog, index: 0 })).toContain("add_keyword");
  });

  test("uses only general destinations and consumes unique catalog values", () => {
    expect(mailAutomationDestinationFolders(catalog).map((folder) => folder.name)).toEqual(["Inbox"]);
    const actions: MailAutomationAction[] = [{ kind: "add_local_tag", tagId: catalog.localTags![0]!.id }];
    expect(mailAutomationActionKindsFor({ actions, catalog })).not.toContain("add_local_tag");
    expect(createMailAutomationAction({ kind: "add_local_tag", actions, catalog })).toBeNull();
  });

  test("creates catalog-backed actions", () => {
    const action = createMailAutomationAction({ kind: "move_to_folder", actions: [], catalog });
    expect(action).toEqual({ kind: "move_to_folder", folderId: catalog.folders[0]!.id });
  });
});
