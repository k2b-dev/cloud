import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { EntityListItem } from "../src/contracts";
import ManagersTab from "../src/frontend/groups/detail/ManagersTab";

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
const row = (id: string, name: string, kind: "agent" | "standalone"): EntityListItem => ({
  kind: "service_account",
  serviceAccount: {
    id,
    name,
    kind,
    status: "active",
    delegatedUserId: null,
    appId: null,
    resourceType: null,
    resourceId: null,
    createdBy: null,
    createdAt: "2026-10-23T12:00:00Z",
  },
  relation: { direct: true },
});
const items = [
  ...(document.body.dataset.revoked === "true" ? [] : [row("11111111-1111-4111-8111-111111111111", "Nightly helper", "agent")]),
  ...(document.body.dataset.added === "true" ? [row("22222222-2222-4222-8222-222222222222", "Release integration", "standalone")] : []),
];
render(
  () => (
    <LocaleProvider locale="en">
      <ManagersTab
        items={items}
        pagination={{ page: 1, per_page: 20, total: items.length, total_pages: 1, has_next: false }}
        groupId="33333333-3333-4333-8333-333333333333"
        groupProvider="local"
        allManagerIds={[]}
        allManagerGroupIds={[]}
        allManagerServiceAccountIds={["11111111-1111-4111-8111-111111111111"]}
        canManage
        isAdmin
        groupHref={() => "/app/accounts/groups/team"}
        pageBaseUrl="/app/accounts/groups/team"
        serviceAccountsToggleUrl="/app/accounts/groups/team"
        showServiceAccounts
      />
    </LocaleProvider>
  ),
  root,
);
