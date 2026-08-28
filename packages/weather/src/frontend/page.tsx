import { AppOverview } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { weatherService } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../config";
import { weatherMessages } from "../messages";
import AddLocationButton from "./AddLocation.island";

export default ssr<AuthContext>(async (c) => {
  const { t } = weatherMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const locations = (await weatherService.location.saved.list({ userId: user.id })).items;
  if (locations.length > 0) {
    return c.redirect(`/app/weather/${locations[0]!.id}`);
  }

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.appName }]}>
      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <AppOverview title={t.appName} subtitle={t.overviewSubtitle} icon="ti ti-temperature-celsius">
          <AppOverview.Main title={t.locations} description={t.noSavedLocations}>
            <AppOverview.EmptyState title={t.noLocationsTitle} description={t.noLocationsDescription} icon="ti ti-map-pin" />
          </AppOverview.Main>

          <AppOverview.Aside title={t.create} description={t.createDescription}>
            <div class="grid grid-cols-1 gap-2">
              <AddLocationButton variant="overview" />
            </div>
          </AppOverview.Aside>
        </AppOverview>
      </div>
    </Layout>
  );
});
