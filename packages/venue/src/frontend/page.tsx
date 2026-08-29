import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../config";
import { venueService } from "../service";
import { venueMessages } from "../messages";
import VenueOverview from "./_components/VenueOverview.island";

export default ssr<AuthContext>(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  const venues = await venueService.venues.list(expectUserBackedActor(c));
  const publicVenues = await venueService.publicResources.projectVenues(venues);
  const templates = venueService.venueTemplates.list(getLocale(c));
  const initialQuery = (c.req.query("q") ?? "").trim();

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.appName }]}>
      <VenueOverview venues={publicVenues} templates={templates} initialQuery={initialQuery} />
    </Layout>
  );
});
