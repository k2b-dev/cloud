import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { settingsService } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { weatherMessages } from "../messages";
import WeatherSettingsForm from "./_components/WeatherSettingsForm.island";

export default ssr<AuthContext>(async (c) => {
  const { t } = weatherMessages.resolve([getLocale(c)]);
  const { items } = await settingsService.entry.list({ filter: { group: "weather" }, locale: getLocale(c) });
  const entries = new Map(items.map((entry) => [entry.key, entry]));
  const formProps = {
    initial: {
      "weather.default_lat": String(entries.get("weather.default_lat")?.value ?? ""),
      "weather.default_lon": String(entries.get("weather.default_lon")?.value ?? ""),
      "weather.cache_minutes": Number(entries.get("weather.cache_minutes")?.value ?? 30),
    },
    unreadable: Object.fromEntries(items.map((entry) => [entry.key, entry.unreadable])),
  };

  return () => (
    <AdminLayout c={c} title={t.appName}>
      <WeatherSettingsForm {...formProps} />
    </AdminLayout>
  );
});
