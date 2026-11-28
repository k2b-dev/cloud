import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { VENUE_PAGE_MAX, type Venue } from "../contracts";
import { venueMessages } from "../messages";
import { venueService } from "../service";
import VenueOverview from "./_components/VenueOverview.island";

/** Every venue the person can read, without images, page by page; a venue that moves between two pages is kept once. */
const readAllVenues = async (user: Parameters<typeof venueService.venues.list>[0]): Promise<Venue[]> => {
  const venues = new Map<string, Venue>();
  for (let offset = 0; ; offset += VENUE_PAGE_MAX) {
    const page = await venueService.venues.list(user, { limit: VENUE_PAGE_MAX, offset, summary: true });
    const before = venues.size;
    for (const venue of page) if (!venues.has(venue.id)) venues.set(venue.id, venue);
    if (page.length !== VENUE_PAGE_MAX || venues.size === before) return [...venues.values()];
  }
};

export default ssr<AuthContext>(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  const venues = (await readAllVenues(expectUserBackedActor(c))).sort((left, right) => left.name.localeCompare(right.name));
  const publicVenues = await venueService.publicResources.projectVenues(venues);
  const templates = venueService.venueTemplates.list(getLocale(c));
  const initialQuery = (c.req.query("q") ?? "").trim();

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.appName }]}>
      <VenueOverview venues={publicVenues} templates={templates} initialQuery={initialQuery} />
    </Layout>
  );
});
