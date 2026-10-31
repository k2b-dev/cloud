import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { read } from "@k2b/cloud/services";
import { ssr } from "../../config";
import { readAttention } from "../_components/ObservabilityArea";
import { HealthCheckView } from "./view";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [attention, schedule, targets] = await Promise.all([
    readAttention(),
    read("gateway.health_check_schedule"),
    read("gateway.webhook_allowed_targets"),
  ]);
  return () => (
    <HealthCheckView
      c={c}
      locale={locale}
      attention={attention}
      values={{ schedule: String(schedule.value), targets: Array.isArray(targets.value) ? targets.value.map(String) : [] }}
      unreadable={{ schedule: schedule.stored === "unreadable", targets: targets.stored === "unreadable" }}
    />
  );
});
