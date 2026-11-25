import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { observabilityAdminNav } from "../_components/admin-nav";
import { areaText, readAttention } from "../_components/ObservabilityArea";
import InfrastructureScreen from "./_components/InfrastructureScreen.island";
import { readInfraSectionWithin } from "./sections";

/**
 * The infrastructure record's overview. Each backend gets the same short budget; one that answers later loads in its
 * own section in the browser, so the record never waits for the slowest backend.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [postgres, valkey, nats, attention] = await Promise.all([
    readInfraSectionWithin("postgres", locale),
    readInfraSectionWithin("valkey", locale),
    readInfraSectionWithin("nats", locale),
    readAttention(),
  ]);
  return () => (
    <AdminLayout c={c} ui="v2" title={areaText(locale).infrastructure}>
      <InfrastructureScreen nav={observabilityAdminNav(c, locale, attention, "infrastructure")} sections={{ postgres, valkey, nats }} />
    </AdminLayout>
  );
});
