import type { AuthContext } from "@valentinkolb/cloud/server";
import { getLocale } from "@valentinkolb/cloud/server";
import { coreSettings } from "@valentinkolb/cloud/services";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../config";
import { weatherMessages } from "../messages";
import WeatherSettingsForm from "./_components/WeatherSettingsForm.island";

export default ssr<AuthContext>(async (c) => {
  const { t } = weatherMessages.resolve([getLocale(c)]);
  const [defaultLat, defaultLon, cacheMinutes, geoUrl] = await Promise.all([
    coreSettings.get<string>("weather.default_lat"),
    coreSettings.get<string>("weather.default_lon"),
    coreSettings.get<number>("weather.cache_minutes"),
    coreSettings.get<string>("weather.geo_url"),
  ]);

  return () => (
    <AdminLayout c={c} title={t.appName}>
      <WeatherSettingsForm
        initial={{
          "weather.default_lat": defaultLat ?? "",
          "weather.default_lon": defaultLon ?? "",
          "weather.cache_minutes": cacheMinutes ?? 30,
          "weather.geo_url": geoUrl ?? "",
        }}
      />
    </AdminLayout>
  );
});
