import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { venueMessages } from "../../messages";
import { loadVenueSettings } from "../page-data";
import VenueSettingsScreen from "../screens/VenueSettingsScreen.island";

/** A venue's settings as a page, for admins: `/settings` is the general tab, `/settings/<tab>` the others. */
export default ssr<AuthContext>(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  const data = await loadVenueSettings(c);
  if (data.kind !== "ok") return data.kind === "redirect" ? c.redirect(data.to) : ssr.error(c, data.status);
  const props = data.props;
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.appName, href: "/app/venue" },
        { title: props.initial.venue.name, href: `/app/venue/${props.initial.venue.id}` },
        { title: t.venueSettings },
      ]}
    >
      <VenueSettingsScreen {...props} />
    </Layout>
  );
});
