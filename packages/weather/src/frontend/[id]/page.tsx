import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { type WeatherData, weatherService } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { weatherMessages } from "../../messages";
import { DailyForecast, HourlyForecast, RadarCard } from "../_components";
import LocationSidebar from "../_components/LocationSidebar";
import LocationActions from "../LocationActions.island";

type Location = {
  id: string;
  name: string;
  state: string | null;
  lat: number;
  lon: number;
};

const CONDITION_ICON_CLASSES = {
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300",
  blue: "bg-blue-50 text-blue-600 dark:bg-blue-950/30 dark:text-blue-300",
  zinc: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-400",
};

function CurrentConditionStat(props: { label: string; value: string; icon: string; tone: keyof typeof CONDITION_ICON_CLASSES }) {
  return (
    <div class="flex min-w-0 items-start gap-2">
      <span class={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md ${CONDITION_ICON_CLASSES[props.tone]}`}>
        <i class={`${props.icon} text-sm`} aria-hidden="true" />
      </span>
      <div class="flex min-w-0 flex-col">
        <span class="truncate text-[10px] font-medium uppercase tracking-wider text-dimmed">{props.label}</span>
        <span class="truncate text-base font-semibold tabular-nums text-primary">{props.value}</span>
      </div>
    </div>
  );
}

function WeatherDetail({ location, data }: { location: Location; data: WeatherData }) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const number = (value: number, maximumFractionDigits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits }).format(value);
  const percent = (value: number) => new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
  const { current, hourly, daily } = data;

  return (
    <article class="flex flex-col gap-2 p-[var(--ui-space-shell)]" aria-label={t().weatherFor({ name: location.name })}>
      <section class="relative flex flex-col items-center gap-3 py-5" aria-label={t().currentWeather}>
        <div class="flex w-full justify-end sm:absolute sm:right-0 sm:top-0">
          <LocationActions id={location.id} lat={location.lat} lon={location.lon} />
        </div>
        <header class="flex max-w-full flex-col items-center text-center" style={`view-transition-name: weather-location-${location.id}`}>
          <h1 class="max-w-full truncate text-lg font-semibold text-primary app-accent-text">{location.name}</h1>
          {location.state && <p class="mt-0.5 max-w-full truncate text-xs text-dimmed">{location.state}</p>}
        </header>
        <div class="flex items-center gap-3">
          <i
            class={`ti ti-${weatherService.ui.getTablerIcon(
              current.icon,
            )} text-5xl ${weatherService.ui.getTempColorClass(current.temperature)}`}
            aria-hidden="true"
            style="view-transition-name: weather-icon"
          />
          <span
            class={`text-5xl font-light ${weatherService.ui.getTempColorClass(current.temperature)}`}
            title={`${t().temperature} ${number(current.temperature, 1)}°`}
            style="view-transition-name: weather-temp"
          >
            {number(current.temperature, 1)}°
          </span>
        </div>
        <dl class="flex items-center gap-6 text-sm">
          <div class="flex flex-col gap-0.5">
            <div class="text-dimmed">
              <dt class="inline">{t().humidity}</dt>{" "}
              <dd class="inline text-secondary font-medium">{current.humidity == null ? "-" : percent(current.humidity)}</dd>
            </div>
            <div class="text-dimmed">
              <dt class="inline">{t().clouds}</dt> <dd class="inline text-secondary font-medium">{percent(current.cloudCover)}</dd>
            </div>
          </div>
          <div class="flex flex-col gap-0.5">
            <div class="text-dimmed">
              <dt class="inline">{t().wind}</dt> <dd class="inline text-secondary font-medium">{number(current.windSpeed)} km/h</dd>
            </div>
            <div class="text-dimmed">
              <dt class="inline">{t().rain}</dt> <dd class="inline text-secondary font-medium">{number(current.precipitation, 1)} mm</dd>
            </div>
          </div>
        </dl>
      </section>

      {hourly.length > 0 && (
        <section class="paper p-4" aria-label={t().hourlyForecast}>
          <h2 class="section-label mb-3">{t().hourly}</h2>
          <HourlyForecast hourly={hourly} scrollPreserveKey={`weather-hourly-${location.id}`} />
        </section>
      )}

      <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div class="flex flex-col gap-2">
          {daily.length > 0 && (
            <section class="paper p-4" aria-label={t().sevenDayForecast}>
              <h2 class="section-label mb-3">{t().sevenDayForecast}</h2>
              <DailyForecast daily={daily} />
            </section>
          )}

          <section class="paper p-4" aria-label={t().currentConditions}>
            <h2 class="section-label mb-3">{t().currentConditions}</h2>
            <div class="grid grid-cols-2 gap-x-6 gap-y-4">
              <CurrentConditionStat
                label={t().pressure}
                value={current.pressure != null ? `${number(current.pressure)} hPa` : "-"}
                icon="ti ti-gauge"
                tone="zinc"
              />
              <CurrentConditionStat
                label={t().dewPoint}
                value={current.dewPoint != null ? `${number(current.dewPoint, 1)}°` : "-"}
                icon="ti ti-droplet"
                tone="blue"
              />
              <CurrentConditionStat
                label={t().visibility}
                value={current.visibility != null ? `${number(current.visibility / 1000, 1)} km` : "-"}
                icon="ti ti-eye"
                tone="zinc"
              />
              <CurrentConditionStat
                label={t().sunshine}
                value={current.sunshine != null ? `${number(current.sunshine)} min` : "-"}
                icon="ti ti-sun"
                tone="amber"
              />
            </div>
          </section>
        </div>

        <section class="paper p-4" aria-label={t().rainRadar}>
          <h2 class="section-label mb-3">{t().rainRadar}</h2>
          <RadarCard showLegend />
        </section>
      </div>
    </article>
  );
}

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
          <AppWorkspace>
            <LocationSidebar locations={locations} activeId={id} weatherMap={new Map()} />
            <AppWorkspace.Content>
              <AppWorkspace.Main>
                <Placeholder
                  state="error"
                  variant="panel"
                  title={t.locationNotFound}
                  description={t.locationNotFoundDescription}
                  icon="ti ti-map-pin-off"
                  class="h-full"
                />
              </AppWorkspace.Main>
            </AppWorkspace.Content>
          </AppWorkspace>
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
        <AppWorkspace>
          <LocationSidebar locations={locations} activeId={id} weatherMap={weatherMap} />

          <AppWorkspace.Content>
            <AppWorkspace.Main scrollPreserveKey={`weather-main-${activeLocation.id}`}>
              {activeWeather ? (
                <WeatherDetail location={activeLocation} data={activeWeather} />
              ) : (
                <Placeholder
                  state="error"
                  variant="panel"
                  title={t.weatherUnavailable}
                  description={t.weatherUnavailableGermany}
                  icon="ti ti-cloud-off"
                  class="h-full"
                  action={<LocationActions id={activeLocation.id} lat={activeLocation.lat} lon={activeLocation.lon} />}
                />
              )}
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </div>
    </Layout>
  );
});
