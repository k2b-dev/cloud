import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { type WeatherData, weatherService } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { weatherMessages } from "../../messages";
import WeatherWorkspace from "../_components/WeatherWorkspace";

export default ssr<AuthContext>(async (c) => {
  const { t } = weatherMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const id = c.req.param("id") ?? "";

  // Get user's locations
  const locations = (await weatherService.location.saved.list({ userId: user.id })).items;

  // Find active location
  const activeLocation = locations.find((l) => l.id === id);
  if (!activeLocation) {
    c.status(404);
    c.header("Cache-Control", "private, no-store");
    return () => (
      <Layout
        c={c}
        fullWidth
        workspaceSidebarCollapsible={false}
        title={[{ title: t.start, href: "/" }, { title: t.appName, href: "/app/weather" }, { title: t.notFound }]}
      >
        <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
          <WeatherWorkspace locations={locations} activeId={id} weatherMap={new Map()} data={null} />
        </div>
      </Layout>
    );
  }

  // Fetch weather data for active location
  const activeWeather = await weatherService.forecast.get({
    lat: String(activeLocation.lat),
    lon: String(activeLocation.lon),
  });

  // Fetch current weather for sidebar preview (quick, parallel)
  const weatherMap = new Map<string, WeatherData | null>();
  const weatherPromises = locations.map(async (loc) => {
    const data = await weatherService.forecast.get({
      lat: String(loc.lat),
      lon: String(loc.lon),
    });
    weatherMap.set(loc.id, data);
  });
  await Promise.all(weatherPromises);

  return () => (
    <Layout
      c={c}
      fullWidth
      workspaceSidebarCollapsible={false}
      title={[{ title: t.start, href: "/" }, { title: t.appName, href: "/app/weather" }, { title: activeLocation.name }]}
    >
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <WeatherWorkspace locations={locations} activeId={id} weatherMap={weatherMap} data={activeWeather} />
      </div>
    </Layout>
  );
});
