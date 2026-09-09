import { LocaleProvider } from "@k2b/ui";
import { getLocale } from "@k2b/cloud/server";
import { weatherService } from "@k2b/cloud/services";
import { ssr } from "../../config";
import { weatherMessages } from "../../messages";
import PublicWeatherDisplay from "./PublicWeatherDisplay.island";
import { parseDisplayCoordinate, parseDisplayRefreshSeconds } from "./runtime";

function ConfigurationError(props: { locale: string }) {
  const { t } = weatherMessages.resolve([props.locale]);
  return (
    <main class="flex min-h-screen items-center justify-center bg-white p-6 text-zinc-900 dark:bg-zinc-950 dark:text-white">
      <div class="max-w-md text-center" role="alert">
        <i class="ti ti-map-pin-off mb-3 block text-4xl text-zinc-300 dark:text-zinc-700" aria-hidden="true" />
        <h1 class="text-lg font-semibold">{t.displayLocationMissing}</h1>
        <p class="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t.displayLocationMissingDescription}</p>
      </div>
    </main>
  );
}

export default ssr(async (c) => {
  const locale = getLocale(c);
  const lat = parseDisplayCoordinate(c.req.query("lat"), -90, 90);
  const lon = parseDisplayCoordinate(c.req.query("lon"), -180, 180);
  const zoomValue = Number.parseInt(c.req.query("zoom") ?? "2", 10);
  const zoom = Math.max(1, Math.min(3, Number.isFinite(zoomValue) ? zoomValue : 2)) as 1 | 2 | 3;
  const refreshSeconds = parseDisplayRefreshSeconds(c.req.query("refresh"));
  const detail = c.req.query("detail") === "true";

  c.get("page").theme = c.req.query("theme") === "dark" ? "dark" : "light";

  if (!lat || !lon) {
    return () => (
      <LocaleProvider locale={locale}>
        <ConfigurationError locale={locale} />
      </LocaleProvider>
    );
  }

  const [initialData, geoResult] = await Promise.all([
    weatherService.forecast.get({ lat, lon }),
    weatherService.location.city.get({ lat: Number(lat), lon: Number(lon) }),
  ]);
  const city = geoResult.ok ? geoResult.data : null;

  return () => (
    <LocaleProvider locale={locale}>
      <PublicWeatherDisplay
        lat={lat}
        lon={lon}
        location={city?.name ?? `${lat}, ${lon}`}
        state={city?.state ?? null}
        initialData={initialData}
        initialNow={new Date().toISOString()}
        zoom={zoom}
        detail={detail}
        refreshSeconds={refreshSeconds}
      />
    </LocaleProvider>
  );
});
