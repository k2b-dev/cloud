import { DialogHeader, dialogCore, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { AccessEntry } from "../contracts/shared";
import CodeAccessSection, { isCodeAccessEntry } from "./CodeAccessSection";
import PermissionEditor from "./PermissionEditor";

// Fictional fixtures from the published mockup's share dialog (studio-mockup v14, screen D).
const person = (id: string, displayName: string, permission: AccessEntry["permission"]): AccessEntry => ({
  id: `access-${id}`,
  principal: { type: "user", userId: `user-${id}` },
  permission,
  createdAt: "2026-10-20T09:00:00.000Z",
  displayName,
});
const code = (id: string, account: string, grantId: string, permission: AccessEntry["permission"]): AccessEntry => ({
  id: `access-${id}`,
  principal: { type: "service_account", serviceAccountId: account },
  permission,
  createdAt: "2026-10-28T09:00:00.000Z",
  displayName: `code:fixture:${id}`,
  serviceAccountKind: "code",
  grantId,
});
const query = new URLSearchParams(location.search);
const entries: AccessEntry[] = [
  person("ben", "Ben Schulz", "admin"),
  person("mia", "Mia Koch", "admin"),
  person("lea", "Lea Muster", "write"),
  {
    id: "access-lager",
    principal: { type: "group", groupId: "group-lager" },
    permission: "read",
    createdAt: "2026-10-20T09:00:00.000Z",
    displayName: "Lager",
  },
  ...(query.get("code") === "none"
    ? []
    : [
        code("info", "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444", "write"),
        code("einkauf", "33333333-3333-4333-8333-333333333333", "55555555-5555-4555-8555-555555555555", "read"),
      ]),
];

const [legacyEntries, setLegacyEntries] = createSignal(entries.filter(isCodeAccessEntry));

// Exercise the retained legacy component independently of the normal A1 editor.
dialogCore.open(
  (close) => (
    <LocaleProvider locale="de">
      <div class="k2b-dialog__panel">
        <DialogHeader title="Space Logistik teilen" close={() => close()} />
        <div class="k2b-dialog__body">
          <PermissionEditor
            expanded={query.get("compact") !== "1"}
            canEdit={query.get("readonly") !== "1"}
            ownEntryIds={["access-ben"]}
            initialEntries={query.get("ordinary") === "1" ? entries : entries.filter((entry) => !isCodeAccessEntry(entry))}
            grantAccess={async () => {
              throw new Error("Not used");
            }}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
          />
          <CodeAccessSection
            entries={query.get("ordinary") === "1" ? [] : legacyEntries()}
            expanded={query.get("compact") !== "1"}
            canEdit={query.get("readonly") !== "1"}
            levelLabel={(entry) => (entry.permission === "write" ? "Bearbeiten" : "Ansehen")}
            manageLabel="Verwalten"
            onRemoved={(entry) => setLegacyEntries((current) => current.filter((item) => item.id !== entry.id))}
          />
        </div>
      </div>
    </LocaleProvider>
  ),
  { panelClassName: "k2b-dialog k2b-dialog--wide", ariaLabel: "Space Logistik teilen" },
);
