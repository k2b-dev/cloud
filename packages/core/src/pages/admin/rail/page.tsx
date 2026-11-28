import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { railShortcuts } from "@k2b/cloud/services";
import { AdminLayout, getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { appsNav } from "../apps/area";
import { railAdminMessages } from "./messages";
import NavigationScreen from "./NavigationScreen.island";

/** Navigation, a section of Apps: the shortcuts of the app bar, and the one the address opens (`?shortcut=`). */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = railAdminMessages.resolve([locale]).t;
  const initial = await railShortcuts.list(c.get("user"));
  // Administrators configure audiences beyond their own roles; final navigation
  // still filters every app against the receiving user's authorized catalog.
  const apps = getLocalizedRuntimeContext(c)
    .apps.filter((app) => app.nav && app.nav.section !== "hidden")
    .map((app) => ({ id: app.id, label: app.name, icon: app.icon }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  const requested = c.req.query("shortcut") ?? null;
  const open = requested === "new" || initial.entries.some((entry) => entry.shortcut.id === requested) ? requested : null;
  return () => (
    <AdminLayout c={c} ui="v2" title={t.title}>
      <NavigationScreen nav={appsNav(c, locale, "navigation")} initial={initial} apps={apps} open={open} />
    </AdminLayout>
  );
});
