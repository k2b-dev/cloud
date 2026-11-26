import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { venueMessages } from "../messages";
import { venueService } from "../service";
import VenueOverviewScreen from "./screens/VenueOverviewScreen.island";

export default ssr<AuthContext>(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  const actor = expectUserBackedActor(c);
  const venues = await venueService.venues.list(actor);
  const [publicVenues, next] = await Promise.all([
    venueService.publicResources.projectVenues(venues),
    venueService.myNextShifts(
      venues.map((venue) => venue.id),
      actor,
      new Date(),
    ),
  ]);
  // keyed by the venue's public id, as the page knows it (the projection keeps the order)
  const nextShifts = Object.fromEntries(
    publicVenues.flatMap((venue, index) => {
      const shift = next.get(venues[index]!.id);
      return shift ? [[venue.id, shift]] : [];
    }),
  );
  const templates = venueService.venueTemplates.list(getLocale(c));
  const initialQuery = (c.req.query("q") ?? "").trim();

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.appName }]}>
      <VenueOverviewScreen venues={publicVenues} nextShifts={nextShifts} templates={templates} initialQuery={initialQuery} />
    </Layout>
  );
});
