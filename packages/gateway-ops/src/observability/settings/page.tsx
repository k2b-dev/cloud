import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { read } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import type { HealthApp, HealthWebhook } from "../../frontend/health-webhook-queries";
import { isHealthWebhookId, listHealthWebhooks } from "../../health-webhooks";
import { observabilityAdminNav } from "../_components/admin-nav";
import { areaText, readAttention, readHealth } from "../_components/ObservabilityArea";
import SettingsFormScreen from "./_components/SettingsFormScreen.island";
import SettingsScreen from "./_components/SettingsScreen.island";

/** Alerts: the list of health webhooks, the open one (`?webhook=<id>`) or a new one (`?webhook=new`) beside it. */
export const alertsPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const param = new URL(c.req.url).searchParams.get("webhook");
  const open = param === "new" || (param && isHealthWebhookId(param)) ? param : null;
  const [attention, webhooks, health] = await Promise.all([
    readAttention(),
    listHealthWebhooks().catch(() => null),
    readHealth().catch(() => null),
  ]);
  // The island receives plain JSON, as the API would send it.
  const rows: HealthWebhook[] | null = webhooks ? JSON.parse(JSON.stringify(webhooks)) : null;
  const apps: HealthApp[] = (health?.apps ?? []).map((app) => ({
    id: app.id,
    name: app.name,
    icon: app.icon,
    status: app.status,
    online: app.online,
    signals: app.signals,
  }));
  const area = areaText(locale);
  return () => (
    <AdminLayout c={c} ui="v2" title={area.settings}>
      <SettingsScreen
        nav={observabilityAdminNav(c, locale, attention, "settings")}
        timeZone={getTimeZone(c)}
        webhooks={rows}
        apps={apps}
        open={open}
      />
    </AdminLayout>
  );
});

/** The health check schedule and the targets health webhooks may reach. */
export const healthCheckPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [attention, schedule, targets] = await Promise.all([
    readAttention(),
    read("gateway.health_check_schedule"),
    read("gateway.webhook_allowed_targets"),
  ]);
  return () => (
    <AdminLayout c={c} ui="v2" title={areaText(locale).settings}>
      <SettingsFormScreen
        nav={observabilityAdminNav(c, locale, attention, "settings")}
        area="health"
        values={{ schedule: String(schedule.value), targets: Array.isArray(targets.value) ? targets.value.map(String) : [] }}
        unreadable={{ schedule: schedule.stored === "unreadable", targets: targets.stored === "unreadable" }}
      />
    </AdminLayout>
  );
});

/** How long logs and request data stay. */
export const retentionPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [attention, logs, events, rollups] = await Promise.all([
    readAttention(),
    read("logs.retention_days"),
    read("gateway.telemetry_event_retention_days"),
    read("gateway.telemetry_rollup_retention_days"),
  ]);
  return () => (
    <AdminLayout c={c} ui="v2" title={areaText(locale).settings}>
      <SettingsFormScreen
        nav={observabilityAdminNav(c, locale, attention, "settings")}
        area="retention"
        values={{ logs: Number(logs.value), events: Number(events.value), rollups: Number(rollups.value) }}
        unreadable={{
          logs: logs.stored === "unreadable",
          events: events.stored === "unreadable",
          rollups: rollups.stored === "unreadable",
        }}
      />
    </AdminLayout>
  );
});
