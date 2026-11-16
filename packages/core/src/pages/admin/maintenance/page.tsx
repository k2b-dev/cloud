import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { NoticeCard } from "@k2b/ui";
import { ssr } from "../../../config";
import { loadMaintenanceAdmin, MAINTENANCE_ADMIN_PATH } from "./load";
import Maintenance from "./Maintenance.island";
import { maintenanceAdminMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const t = maintenanceAdminMessages.resolve([getLocale(c)]).t;
  const loaded = await loadMaintenanceAdmin(c.get("user"));
  if (!loaded.ok) c.status(loaded.error.code === "FORBIDDEN" ? 403 : 503);
  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="app-rows">
        {loaded.ok ? (
          <Maintenance
            initial={loaded.data.status}
            appNames={loaded.data.appNames}
            dateConfig={getDateConfig(c)}
            path={MAINTENANCE_ADMIN_PATH}
          />
        ) : (
          <NoticeCard tone="danger" icon="ti ti-alert-circle" role="alert">
            {loaded.error.code === "FORBIDDEN" ? t.forbidden : t.unavailable}
          </NoticeCard>
        )}
      </div>
    </AdminLayout>
  );
});
