import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { ssr } from "../../config";
import type { HealthApp, HealthWebhook } from "../../frontend/health-webhook-queries";
import { isHealthWebhookId, listHealthWebhooks } from "../../health-webhooks";
import { readAttention, readHealth } from "../_components/ObservabilityArea";
import { AlertsView } from "./view";

const settle = <T,>(load: () => Promise<T>) =>
  load()
    .then((value) => ({ value, error: null as string | null }))
    .catch((error) => ({ value: null, error: error instanceof Error ? error.message : String(error) }));

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const param = new URL(c.req.url).searchParams.get("webhook");
  const selectedId = param && isHealthWebhookId(param) ? param : null;
  const [attention, webhooks, health] = await Promise.all([readAttention(), settle(listHealthWebhooks), settle(readHealth)]);
  // The island receives plain JSON, as the API would send it.
  const rows: HealthWebhook[] = webhooks.value ? JSON.parse(JSON.stringify(webhooks.value)) : [];
  const apps: HealthApp[] = (health.value?.apps ?? []).map((app) => ({
    id: app.id,
    name: app.name,
    icon: app.icon,
    status: app.status,
    online: app.online,
    signals: app.signals,
  }));
  return () => (
    <AlertsView
      c={c}
      locale={locale}
      timeZone={getTimeZone(c)}
      attention={attention}
      rows={rows}
      apps={apps}
      loadError={webhooks.error}
      selectedId={selectedId}
    />
  );
});
