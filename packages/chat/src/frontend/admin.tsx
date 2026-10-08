import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { StatCell, StatGrid } from "@k2b/ui";
import { ssr } from "../config";
import { chatMessages } from "../messages";
import { chatService } from "../service";

/** `/admin/chat`: operational state. Later slices add their rows to the same health snapshot. */
export default ssr<AuthContext>(async (c) => {
  const { t } = chatMessages.resolve([getLocale(c)]);
  const health = await chatService.health();
  const ok = health.status === "ok";
  const time = dates.formatTime(health.observedAt, getDateConfig(c));

  return () => (
    <AdminLayout c={c} title={t.appName}>
      <div class="app-rows">
        <h1 class="text-base font-semibold text-primary">{t.appName}</h1>
        <StatGrid title={t.operations} columns={2} action={{ label: t.logs, href: "/admin/observability/logs?search=chat" }}>
          <StatCell
            label={t.state}
            value={ok ? t.healthy : t.unavailable}
            sub={t.observed({ time })}
            valueClass={ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}
            accent={ok ? { tone: "emerald", icon: "ti ti-check" } : { tone: "red", icon: "ti ti-alert-triangle" }}
          />
          <StatCell
            label={t.database}
            value={health.database.status === "ok" ? t.databaseReady : t.databaseUnavailable}
            sub={health.database.latencyMs === null ? undefined : t.latency({ value: health.database.latencyMs })}
          />
        </StatGrid>
      </div>
    </AdminLayout>
  );
});
