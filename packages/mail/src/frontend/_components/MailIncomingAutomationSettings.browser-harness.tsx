import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { IncomingAutomation } from "../../service/incoming-automations";
import MailIncomingAutomationSettings from "./MailIncomingAutomationSettings";

declare global {
  interface Window {
    mountIncomingAutomations: (locale: "en" | "de") => void;
  }
}

const now = "2026-11-01T09:00:00.000Z";
const base = {
  mailboxId: "Box001",
  scope: { mode: "all" as const },
  latestBackfillOperationId: null,
  workflowSource: "steps: []",
  revision: 3,
  createdAt: now,
  updatedAt: now,
};
// Fictional data: one automation still runs, one lost its Spaces destination in the target migration.
const automations: IncomingAutomation[] = [
  {
    ...base,
    id: "Auto01",
    workflowId: "00000000-0000-4000-8000-000000000001",
    workflowVersionId: "00000000-0000-4000-8000-000000000002",
    name: "Rechnungen markieren",
    enabled: true,
    steps: [{ id: "00000000-0000-4000-8000-000000000003", kind: "mail_action", action: { kind: "mark_read" } }],
    authorizationState: "ready",
  },
  {
    ...base,
    id: "Auto02",
    workflowId: "00000000-0000-4000-8000-000000000004",
    workflowVersionId: "00000000-0000-4000-8000-000000000005",
    name: "Lieferungen in Space Logistik",
    enabled: false,
    steps: [{ id: "00000000-0000-4000-8000-000000000006", kind: "link_space_item", itemId: "Itm001" }],
    authorizationState: "needs_attention",
  },
];

window.mountIncomingAutomations = (locale) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = locale;
  // The settings read nothing else for this state; any other request answers empty.
  window.fetch = Object.assign(async () => Response.json({ items: [], data: [] }), { preconnect: window.fetch.preconnect });
  render(
    () => (
      <LocaleProvider locale={locale}>
        <div class="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6" data-incoming-automations>
          <MailIncomingAutomationSettings
            mailboxId="Box001"
            catalog={{ folders: [], assignableUsers: [] }}
            initialAutomations={automations}
          />
        </div>
      </LocaleProvider>
    ),
    host,
  );
};
