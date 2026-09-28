import { describe, expect, test } from "bun:test";
import type { MailAutomationAction } from "../../contracts";
import type { MailWorkflowCatalogSnapshot } from "../../workflows/catalog";
import { createMailAutomationAction, mailAutomationActionKindsFor, mailAutomationDestinationFolders } from "./mail-automation-actions";

const catalog: MailWorkflowCatalogSnapshot = {
  folders: [
    { id: "00000000-0000-4000-8000-000000000001", name: "Inbox", role: "inbox" },
    { id: "00000000-0000-4000-8000-000000000002", name: "Junk", role: "junk" },
  ],
  assignableUsers: [{ id: "00000000-0000-4000-8000-000000000003", name: "Ada" }],
  localTags: [{ id: "00000000-0000-4000-8000-000000000004", name: "Customer", color: "#2563eb" }],
};

describe("mail automation action editor model", () => {
  test("offers one provider action and composable collaboration actions", () => {
    const actions: MailAutomationAction[] = [{ kind: "mark_read" }];
    expect(mailAutomationActionKindsFor({ actions, catalog })).toEqual(["add_local_tag", "assign_user", "set_status"]);
    expect(mailAutomationActionKindsFor({ actions, catalog, index: 0 })).toContain("move_to_folder");
    expect(mailAutomationActionKindsFor({ actions: [], catalog })).not.toContain("add_keyword");
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
