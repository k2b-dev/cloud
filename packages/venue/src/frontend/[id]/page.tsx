import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { venueMessages } from "../../messages";
import { loadVenueWorkspace } from "../page-data";
import VenueScreen from "../screens/VenueScreen.island";

export default ssr<AuthContext>(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  const data = await loadVenueWorkspace(c);
  if (data.kind !== "ok") return data.kind === "redirect" ? c.redirect(data.to) : ssr.error(c, data.status);
  const { venueName, ...props } = data.props;
  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.appName, href: "/app/venue" }, { title: venueName }]} fullWidth ui="v2">
      <VenueScreen {...props} />
    </Layout>
  );
});
