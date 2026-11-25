import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { weatherService } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { weatherMessages } from "../../messages";
import WeatherScreen from "../WeatherScreen.island";
import { weatherFormat } from "../weather-view";

/** One saved location on v2; the sidebar shows every saved location with its current symbol and temperature. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = weatherMessages.resolve([locale]);
  const user = expectUserBackedActor(c);
  const id = c.req.param("id") ?? "";
  const locations = (await weatherService.location.saved.list({ userId: user.id })).items;
  const active = locations.find((location) => location.id === id);
  // Every location's forecast (the sidebar shows its current weather); the provider cache answers repeated ones.
  const forecasts = await Promise.all(
    locations.map((location) => weatherService.forecast.get({ lat: String(location.lat), lon: String(location.lon) })),
  );
  const format = weatherFormat(locale, t, new Date());
  const places = locations.map((location, index) => format.place(location, forecasts[index]));
  const activeWeather = active ? forecasts[locations.indexOf(active)] : null;

  if (!active) {
    c.status(404);
    c.header("Cache-Control", "private, no-store");
  }
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.appName, href: "/app/weather" }, { title: active?.name ?? t.notFound }]}
    >
      <WeatherScreen
        places={places}
        missing={!active}
        open={
          active
            ? {
                id: active.id,
                name: active.name,
                state: active.state,
                lat: active.lat,
                lon: active.lon,
                geoapify: Boolean(active.provenance),
              }
            : null
        }
        weather={activeWeather ? format.weather(activeWeather) : null}
      />
    </Layout>
  );
});
