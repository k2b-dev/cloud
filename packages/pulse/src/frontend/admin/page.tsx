import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ViewTabs } from "@k2b/ui";
import { Hono } from "hono";
import { ssr } from "../../config";
import { listAdminBases, listInternalTargets } from "../../service/base-admin";
import { getPolicy } from "../../service/base-policy";
import { storeAdmin } from "../../store/service";
import BasesAdmin from "./BasesAdmin.island";
import { pulseAdminMessages } from "./pulse-admin-messages";
import StoreAdmin from "./StoreAdmin.island";
import TargetsAdmin from "./TargetsAdmin.island";

const VIEWS = ["store", "bases", "targets"] as const;
type View = (typeof VIEWS)[number];
const PAGE_SIZE = 50;

/** A failed read becomes the island's own error state with "Try again"; the page itself always renders. */
const attempt = async <T,>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

const page = ssr<AuthContext>(async (c) => {
  const identity = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
  const requested = c.req.query("view");
  const view: View = VIEWS.find((item) => item === requested) ?? "store";
  // Only Postgres reads: a slow or unavailable ClickHouse must never delay this page.
  const [store, bases, targets, policy] = await Promise.all([
    view === "store" ? storeAdmin.read(identity) : null,
    attempt(() => listAdminBases(identity, { limit: view === "bases" ? PAGE_SIZE : 1 })),
    attempt(() => listInternalTargets(identity, { limit: view === "targets" ? PAGE_SIZE : 1 })),
    view === "bases" ? attempt(() => getPolicy(identity)) : null,
  ]);
  const t = pulseAdminMessages.resolve([getLocale(c)]).t;
  const tabs = [
    { id: "store", label: t.tabStore, href: "?view=store" },
    { id: "bases", label: t.tabBases, href: "?view=bases", count: bases?.total },
    { id: "targets", label: t.tabTargets, href: "?view=targets", count: targets?.total },
  ];
  return () => (
    <AdminLayout c={c} title={t.pageTitle}>
      <div class="flex flex-col gap-6">
        <h1 class="sr-only">{`${t.pageTitle}: ${tabs.find((tab) => tab.id === view)?.label ?? ""}`}</h1>
        <ViewTabs label={t.tabsLabel} items={tabs} current={view} />
        {view === "store" && store ? <StoreAdmin initial={store} /> : null}
        {view === "bases" ? <BasesAdmin initialPolicy={policy} initialPage={bases} /> : null}
        {view === "targets" ? <TargetsAdmin initialPage={targets} /> : null}
      </div>
    </AdminLayout>
  );
});
export default new Hono<AuthContext>()
  .use("*", auth.requireRole("admin", ssr.access))
  .use("*", auth.requireUser(ssr.access))
  .get("/", ...page);
