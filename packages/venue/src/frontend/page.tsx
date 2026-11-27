import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { venueMessages } from "../messages";
import { loadVenueOverview } from "./page-data";
import VenueOverviewScreen from "./screens/VenueOverviewScreen.island";

export default ssr<AuthContext>(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  const data = await loadVenueOverview(c);
  if (data.kind !== "ok") return data.kind === "redirect" ? c.redirect(data.to) : ssr.error(c, data.status);
  const props = data.props;
  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.appName }]}>
      <VenueOverviewScreen {...props} />
    </Layout>
  );
});
