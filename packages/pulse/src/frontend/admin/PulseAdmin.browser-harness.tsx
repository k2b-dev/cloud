import { LocaleProvider, ViewTabs } from "@k2b/ui";
import { render } from "solid-js/web";
import type { AdminBasesPage, InternalTargetsPage, PulsePolicy } from "../../store/admin-contracts";
import BasesAdmin from "./BasesAdmin.island";
import { pulseAdminMessages } from "./pulse-admin-messages";
import TargetsAdmin from "./TargetsAdmin.island";

// The browser test passes the server snapshot of one tab and the locale in the page's own script tag.
type Snapshot =
  | { view: "bases"; locale: string; policy: PulsePolicy | null; page: AdminBasesPage | null }
  | { view: "targets"; locale: string; page: InternalTargetsPage | null };
const snapshot = (window as unknown as { __admin: Snapshot }).__admin;
const root = document.getElementById("root");
if (!root) throw new Error("Missing harness root");
const t = pulseAdminMessages.resolve([snapshot.locale]).t;
render(
  () => (
    <LocaleProvider locale={snapshot.locale}>
      <div class="flex flex-col gap-6">
        <ViewTabs
          label={t.tabsLabel}
          current={snapshot.view}
          items={[
            { id: "store", label: t.tabStore, href: "?view=store" },
            { id: "bases", label: t.tabBases, href: "?view=bases", count: 3 },
            { id: "targets", label: t.tabTargets, href: "?view=targets", count: 3 },
          ]}
        />
        {snapshot.view === "bases" ? (
          <BasesAdmin initialPolicy={snapshot.policy} initialPage={snapshot.page} />
        ) : (
          <TargetsAdmin initialPage={snapshot.page} />
        )}
      </div>
    </LocaleProvider>
  ),
  root,
);
