import { timing } from "@k2b/stdlib";
import { timed } from "@k2b/stdlib/solid";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { WeatherDataPayload } from "../../contracts";
import { weatherMessages } from "../../messages";
import { DetailDisplayView, DisplayUnavailable, SimpleDisplayView } from "./DisplayViews";
import { displayInitialRefreshDelayMs, displayRefreshBackoffMs } from "./runtime";
import { createWeatherDisplayQuery } from "./weather-display-query";

type PublicWeatherDisplayProps = {
  lat: string;
  lon: string;
  location: string;
  state: string | null;
  initialData: WeatherDataPayload | null;
  initialNow: string;
  zoom: 1 | 2 | 3;
  detail: boolean;
  refreshSeconds: number;
};

export default function PublicWeatherDisplay(props: PublicWeatherDisplayProps) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const [now, setNow] = createSignal(props.initialNow);
  const [refreshedAt, setRefreshedAt] = createSignal<string | null>(null);
  const weather = createWeatherDisplayQuery(props, locale);
  let disposed = false;
  let failures = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let lastData = props.initialData;

  const clock = timed.interval(() => setNow(new Date().toISOString()), 30_000, {
    autoStart: false,
    executeImmediately: false,
  });

  createEffect(() => {
    const nextData = weather.data();
    if (!nextData || nextData === lastData) return;
    lastData = nextData;
    failures = 0;
    const timestamp = new Date().toISOString();
    setNow(timestamp);
    setRefreshedAt(timestamp);
  });

  const nextDelay = () => Math.max(1_000, timing.jitter(displayRefreshBackoffMs(props.refreshSeconds, failures), 350));

  const schedule = (delay: number) => {
    if (disposed) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void run(), delay);
  };

  const run = async () => {
    if (disposed) return;
    if (document.hidden) {
      schedule(displayRefreshBackoffMs(props.refreshSeconds, 0));
      return;
    }
    if (weather.refreshing() || weather.loading()) {
      schedule(nextDelay());
      return;
    }
    await weather.refresh();
    const error = weather.error();
    if (error) {
      failures += 1;
      console.warn("Weather display refresh failed", error);
    }
    schedule(nextDelay());
  };

  const handleVisibilityChange = () => {
    if (!document.hidden) schedule(0);
  };

  const handleOnline = () => schedule(0);

  onMount(() => {
    if (typeof document === "undefined") return;
    clock.start();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    schedule(displayInitialRefreshDelayMs(Boolean(weather.data()), props.refreshSeconds));
  });

  onCleanup(() => {
    disposed = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    }
    weather.abort();
  });

  const viewProps = () => ({
    data: weather.data()!,
    location: props.location,
    state: props.state,
    zoom: props.zoom,
    now: now(),
    refreshSeconds: props.refreshSeconds,
    refreshedAt: refreshedAt(),
  });

  return (
    <>
      <Show when={weather.error() && weather.data()}>
        <div class="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-lg">
          <NoticeCard tone="warning" title={t().refreshFailed} detail={weather.error()!.message}>
            <Button variant="secondary" size="sm" onClick={() => schedule(0)}>
              {t().retry}
            </Button>
          </NoticeCard>
        </div>
      </Show>
      <Show
        when={weather.data()}
        fallback={
          <DisplayUnavailable
            message={weather.error()?.message ?? t().providerUnavailable}
            refreshSeconds={props.refreshSeconds}
            refreshedAt={refreshedAt()}
            retrying
          />
        }
      >
        {props.detail ? <DetailDisplayView {...viewProps()} /> : <SimpleDisplayView {...viewProps()} />}
      </Show>
    </>
  );
}
