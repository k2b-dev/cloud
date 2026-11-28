import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { loadMaintenanceAdmin, MAINTENANCE_ADMIN_PATH } from "./load";
import Maintenance from "./Maintenance.island";
import { maintenanceAdminMessages } from "./messages";
import { defaultEnd } from "./time";
import MaintenanceUnavailable from "./Unavailable.island";

export default ssr<AuthContext>(async (c) => {
  const t = maintenanceAdminMessages.resolve([getLocale(c)]).t;
  const loaded = await loadMaintenanceAdmin(c.get("user"));
  if (!loaded.ok) c.status(loaded.error.code === "FORBIDDEN" ? 403 : 503);
  return () => (
    <AdminLayout c={c} ui="v2" title={t.title}>
      {loaded.ok ? (
        <Maintenance
          nav={adminNavigation(c)}
          initial={loaded.data.status}
          appNames={loaded.data.appNames}
          dateConfig={getDateConfig(c)}
          path={MAINTENANCE_ADMIN_PATH}
          suggestedEnd={defaultEnd()}
        />
      ) : (
        <MaintenanceUnavailable
          nav={adminNavigation(c)}
          title={t.title}
          message={loaded.error.code === "FORBIDDEN" ? t.forbidden : t.unavailable}
        />
      )}
    </AdminLayout>
  );
});
