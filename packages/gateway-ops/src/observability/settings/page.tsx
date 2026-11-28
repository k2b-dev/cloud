import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { read } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import type { HealthApp, HealthWebhook } from "../../frontend/health-webhook-queries";
import { getHealthWebhook, isHealthWebhookId, listHealthWebhooks } from "../../health-webhooks";
import { observabilityAdminNav } from "../_components/admin-nav";
import { areaText, readAttention, readHealth } from "../_components/ObservabilityArea";
import SettingsFormScreen from "./_components/SettingsFormScreen.island";
import SettingsScreen from "./_components/SettingsScreen.island";

/** Alerts the list shows, in name order; a person with more finds the rest through the address of each. */
export const ALERTS_SHOWN = 100;

/** Alerts: the list of health webhooks, the open one (`?webhook=<id>`) or a new one (`?webhook=new`) beside it. */
export const alertsPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const param = new URL(c.req.url).searchParams.get("webhook");
  const open = param === "new" || (param && isHealthWebhookId(param)) ? param : null;
  const [attention, webhooks, health, opened] = await Promise.all([
    readAttention(),
    // one more than shown, to know whether more exist
    listHealthWebhooks({ limit: ALERTS_SHOWN + 1 }).catch(() => null),
    readHealth().catch(() => null),
    // the open alert on its own, so one beyond the first page still opens
    open && open !== "new" ? getHealthWebhook(open).catch(() => null) : null,
  ]);
  // The island receives plain JSON, as the API would send it.
  const rows: HealthWebhook[] | null = webhooks ? JSON.parse(JSON.stringify(webhooks.slice(0, ALERTS_SHOWN))) : null;
  const openWebhook: HealthWebhook | null = opened ? JSON.parse(JSON.stringify(opened)) : null;
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
        more={(webhooks?.length ?? 0) > ALERTS_SHOWN}
        openWebhook={openWebhook}
        apps={apps}
        open={open}
      />
    </AdminLayout>
  );
});

/** The health check and the retention of operational data, in one form. */
export const generalPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [attention, schedule, targets, logs, events, rollups] = await Promise.all([
    readAttention(),
    read("gateway.health_check_schedule"),
    read("gateway.webhook_allowed_targets"),
    read("logs.retention_days"),
    read("gateway.telemetry_event_retention_days"),
    read("gateway.telemetry_rollup_retention_days"),
  ]);
  return () => (
    <AdminLayout c={c} ui="v2" title={areaText(locale).settings}>
      <SettingsFormScreen
        nav={observabilityAdminNav(c, locale, attention, "settings")}
        values={{
          schedule: String(schedule.value),
          targets: Array.isArray(targets.value) ? targets.value.map(String) : [],
          logs: Number(logs.value),
          events: Number(events.value),
          rollups: Number(rollups.value),
        }}
        unreadable={{
          schedule: schedule.stored === "unreadable",
          targets: targets.stored === "unreadable",
          logs: logs.stored === "unreadable",
          events: events.stored === "unreadable",
          rollups: rollups.stored === "unreadable",
        }}
      />
    </AdminLayout>
  );
});
