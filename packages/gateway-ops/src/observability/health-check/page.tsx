import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { read } from "@k2b/cloud/services";
import { ssr } from "../../config";
import { readAttention } from "../_components/ObservabilityArea";
import { HealthCheckView } from "./view";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [attention, schedule] = await Promise.all([readAttention(), read("gateway.health_check_schedule")]);
  return () => (
    <HealthCheckView
      c={c}
      locale={locale}
      attention={attention}
      schedule={String(schedule.value)}
      unreadable={schedule.stored === "unreadable"}
    />
  );
});
