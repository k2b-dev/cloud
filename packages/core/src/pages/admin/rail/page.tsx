import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { railShortcuts } from "@k2b/cloud/services";
import { AdminLayout, getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import RailAdmin from "./RailAdmin.island";
import { railAdminMessages } from "./messages";

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
  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="app-rows">
        <RailAdmin initial={initial} apps={apps} />
      </div>
    </AdminLayout>
  );
});
