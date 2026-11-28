import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { Hono } from "hono";
import { ssr } from "../../config";
import { listAdminBases, listInternalTargets } from "../../service/base-admin";
import { getPolicy } from "../../service/base-policy";
import { storeAdmin } from "../../store/service";
import { ADMIN_VIEWS, type AdminView } from "./AdminScreen";
import AdminScreen from "./AdminScreen.island";
import { pulseAdminMessages } from "./pulse-admin-messages";

const PAGE_SIZE = 50;

/** A failed read becomes the view's own Failed state with a way to load again; the page itself always renders. */
const attempt = async <T,>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/** Pulse in the administration on v2. `?view=` names the section; the admin bar shows the sections one level in. */
const page = ssr<AuthContext>(async (c) => {
  const identity = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
  const requested = c.req.query("view");
  const view: AdminView = ADMIN_VIEWS.find((item) => item === requested) ?? "store";
  // Only Postgres reads: a slow or unavailable ClickHouse must never delay this page.
  const [store, bases, targets, policy] = await Promise.all([
    view === "store" ? storeAdmin.read(identity) : null,
    view === "bases" ? attempt(() => listAdminBases(identity, { limit: PAGE_SIZE })) : null,
    view === "targets" ? attempt(() => listInternalTargets(identity, { limit: PAGE_SIZE })) : null,
    view === "bases" ? attempt(() => getPolicy(identity)) : null,
  ]);
  const t = pulseAdminMessages.resolve([getLocale(c)]).t;
  const nav = adminNavigation(c, [
    { label: t.tabStore, icon: "database", href: "/admin/pulse?view=store", current: view === "store" },
    { label: t.tabBases, icon: "stack-2", href: "/admin/pulse?view=bases", current: view === "bases" },
    { label: t.tabTargets, icon: "route", href: "/admin/pulse?view=targets", current: view === "targets" },
  ]);
  return () => (
    <AdminLayout c={c} title={t.pageTitle} ui="v2">
      <AdminScreen nav={nav} view={view} store={store} policy={policy} bases={bases} targets={targets} />
    </AdminLayout>
  );
});
export default new Hono<AuthContext>()
  .use("*", auth.requireRole("admin", ssr.access))
  .use("*", auth.requireUser(ssr.access))
  .get("/", ...page);
