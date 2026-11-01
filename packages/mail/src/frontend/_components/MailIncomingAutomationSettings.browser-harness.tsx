import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory-settings";
import type { IncomingAutomation } from "../../service/incoming-automations";
import MailIncomingAutomationsPage from "../MailIncomingAutomationsPage.island";

const automation: IncomingAutomation = {
  id: "Auto01",
  mailboxId: "Box001",
  workflowId: "00000000-0000-4000-8000-000000000001",
  workflowVersionId: "00000000-0000-4000-8000-000000000002",
  name: "Create a receipt task",
  enabled: false,
  authorizationState: "needs_attention",
  scope: { mode: "all" },
  steps: [{ id: "00000000-0000-4000-8000-000000000003", kind: "link_space_item", itemId: "Item01" }],
  latestBackfillOperationId: null,
  workflowSource: "steps: []",
  revision: 4,
  createdAt: "2026-10-11T09:00:00.000Z",
  updatedAt: "2026-10-11T09:00:00.000Z",
};

render(
  () => (
    <LocaleProvider locale="en">
      <MailIncomingAutomationsPage
        data={{
          mailbox: {
            id: "Box001",
            name: "Example support",
            description: null,
            health: "active",
            healthReason: null,
            syncEnabled: true,
            searchBackend: "auto",
            automaticReplyManagementPermission: "admin",
            accessScope: "mailbox",
            composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
            createdAt: automation.createdAt,
            updatedAt: automation.updatedAt,
          },
          permission: "admin",
          catalog: { folders: [], assignableUsers: [] },
          incomingAutomations: [automation],
        }}
        currentUserEmail="reader@example.test"
        contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
        openPreset={null}
      />
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
