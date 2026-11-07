import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { read } from "@k2b/cloud/services";
import { ssr } from "../../config";
import { readAttention } from "../_components/ObservabilityArea";
import { RetentionView } from "./view";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [attention, logs, events, rollups] = await Promise.all([
    readAttention(),
    read("logs.retention_days"),
    read("gateway.telemetry_event_retention_days"),
    read("gateway.telemetry_rollup_retention_days"),
  ]);
  return () => (
    <RetentionView
      c={c}
      locale={locale}
      attention={attention}
      values={{ logs: Number(logs.value), events: Number(events.value), rollups: Number(rollups.value) }}
      unreadable={{
        logs: logs.stored === "unreadable",
        events: events.stored === "unreadable",
        rollups: rollups.stored === "unreadable",
      }}
    />
  );
});
