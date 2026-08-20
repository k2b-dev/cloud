import { AppWorkspace, Placeholder, ScrollArea } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor } from "@valentinkolb/cloud/server";
import { type WeatherData, weatherService } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
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
  const { current, hourly, daily } = data;

  return (
    <article class="flex flex-col gap-2 p-[var(--ui-space-shell)]" aria-label={`Weather for ${location.name}`}>
      <section class="relative flex flex-col items-center gap-3 py-5" aria-label="Current weather">
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
            title={`Temperature ${weatherService.ui.formatTemp(current.temperature)}`}
            style="view-transition-name: weather-temp"
          >
            {weatherService.ui.formatTemp(current.temperature)}
          </span>
        </div>
        <dl class="flex items-center gap-6 text-sm">
          <div class="flex flex-col gap-0.5">
            <div class="text-dimmed">
              <dt class="inline">Humidity</dt> <dd class="inline text-secondary font-medium">{current.humidity ?? "-"}%</dd>
            </div>
            <div class="text-dimmed">
              <dt class="inline">Clouds</dt> <dd class="inline text-secondary font-medium">{current.cloudCover}%</dd>
            </div>
          </div>
          <div class="flex flex-col gap-0.5">
            <div class="text-dimmed">
              <dt class="inline">Wind</dt> <dd class="inline text-secondary font-medium">{current.windSpeed} km/h</dd>
            </div>
            <div class="text-dimmed">
              <dt class="inline">Rain</dt> <dd class="inline text-secondary font-medium">{current.precipitation} mm</dd>
            </div>
          </div>
        </dl>
      </section>

      {hourly.length > 0 && (
        <section class="paper p-4" aria-label="Hourly forecast">
          <h2 class="section-label mb-3">Hourly</h2>
          <HourlyForecast hourly={hourly} scrollPreserveKey={`weather-hourly-${location.id}`} />
        </section>
      )}

      <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div class="flex flex-col gap-2">
          {daily.length > 0 && (
            <section class="paper p-4" aria-label="7-day forecast">
              <h2 class="section-label mb-3">7-day forecast</h2>
              <DailyForecast daily={daily} />
            </section>
          )}

          <section class="paper p-4" aria-label="Current conditions">
            <h2 class="section-label mb-3">Current conditions</h2>
            <div class="grid grid-cols-2 gap-x-6 gap-y-4">
              <CurrentConditionStat
                label="Pressure"
                value={current.pressure != null ? `${current.pressure} hPa` : "-"}
                icon="ti ti-gauge"
                tone="zinc"
              />
              <CurrentConditionStat
                label="Dew point"
                value={current.dewPoint != null ? `${current.dewPoint}°` : "-"}
                icon="ti ti-droplet"
                tone="blue"
              />
              <CurrentConditionStat
                label="Visibility"
                value={current.visibility != null ? `${(current.visibility / 1000).toFixed(1)} km` : "-"}
                icon="ti ti-eye"
                tone="zinc"
              />
              <CurrentConditionStat
                label="Sunshine"
                value={current.sunshine != null ? `${current.sunshine} min` : "-"}
                icon="ti ti-sun"
                tone="amber"
              />
            </div>
          </section>
        </div>

        <section class="paper p-4" aria-label="Rain radar">
          <h2 class="section-label mb-3">Rain radar</h2>
          <RadarCard showLegend />
        </section>
      </div>
    </article>
  );
}

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const id = c.req.param("id") ?? "";

  // Get user's locations
  const locations = (await weatherService.location.saved.list({ userId: user.id })).items;

  // Find active location
  const activeLocation = locations.find((l) => l.id === id);
  if (!activeLocation) {
    return () => (
      <Layout
        c={c}
        fullWidth
        workspaceSidebarCollapsible={false}
        title={[{ title: "Start", href: "/" }, { title: "Weather", href: "/app/weather" }, { title: "Not Found" }]}
      >
        <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
          <AppWorkspace>
            <LocationSidebar locations={locations} activeId={id} weatherMap={new Map()} />
            <AppWorkspace.Content>
              <AppWorkspace.Main>
                <Placeholder
                  state="error"
                  variant="panel"
                  title="Location not found"
                  description="Choose another saved location or add a new city."
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
      title={[{ title: "Start", href: "/" }, { title: "Weather", href: "/app/weather" }, { title: activeLocation.name }]}
    >
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <AppWorkspace>
          <LocationSidebar locations={locations} activeId={id} weatherMap={weatherMap} />

          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <ScrollArea class="flex-1" scrollPreserveKey={`weather-main-${activeLocation.id}`}>
                {activeWeather ? (
                  <WeatherDetail location={activeLocation} data={activeWeather} />
                ) : (
                  <Placeholder
                    state="error"
                    variant="panel"
                    title="Weather data unavailable"
                    description="DWD currently provides forecast data only for locations in Germany."
                    icon="ti ti-cloud-off"
                    class="h-full"
                    action={<LocationActions id={activeLocation.id} lat={activeLocation.lat} lon={activeLocation.lon} />}
                  />
                )}
              </ScrollArea>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </div>
    </Layout>
  );
});
