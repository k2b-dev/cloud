import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { weatherService } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { weatherMessages } from "../messages";
import WeatherScreen from "./WeatherScreen.island";

/** The first saved location opens at once; without one, the page says so and offers to add a city. */
export default ssr<AuthContext>(async (c) => {
  const { t } = weatherMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const locations = (await weatherService.location.saved.list({ userId: user.id })).items;
  if (locations.length > 0) {
    return c.redirect(`/app/weather/${locations[0]!.id}`);
  }

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.appName }]}>
      <WeatherScreen places={[]} open={null} weather={null} />
    </Layout>
  );
});
