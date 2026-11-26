import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { venueMessages } from "../../messages";
import { venueService } from "../../service";
import { loadVenueSettingsContext } from "../../service/settings-context";
import VenueSettingsScreen from "../screens/VenueSettingsScreen.island";
import type { VenueSettingsTab } from "../screens/venue-nav";

const TABS: readonly VenueSettingsTab[] = ["general", "access", "schedule", "danger"];

/** A venue's settings as a page, for admins: `/settings` is the general tab, `/settings/<tab>` the others. */
export default ssr<AuthContext>(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  const id = c.req.param("id") ?? "";
  const requested = c.req.param("tab");
  const tab = TABS.find((entry) => entry === requested);
  if (requested !== undefined && (!tab || tab === "general")) return c.redirect(`/app/venue/${encodeURIComponent(id)}/settings`);
  const user = expectUserBackedActor(c);
  const resolved = await venueService.venues.resolve(id, user, "read");
  if (!resolved.ok) return ssr.error(c, resolved.error.status);
  // Everyone else reads the venue where it works for them; the settings are the admins' own place.
  if (resolved.data.permission !== "admin") return c.redirect(`/app/venue/${encodeURIComponent(id)}/shifts`);
  const settings = await loadVenueSettingsContext(resolved.data);
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.appName, href: "/app/venue" },
        { title: settings.venue.name, href: `/app/venue/${settings.venue.id}` },
        { title: t.venueSettings },
      ]}
    >
      <VenueSettingsScreen
        initial={settings}
        dashboard={{ venue: settings.venue, myShiftCount: 0, feedback: null }}
        tab={tab ?? "general"}
      />
    </Layout>
  );
});
