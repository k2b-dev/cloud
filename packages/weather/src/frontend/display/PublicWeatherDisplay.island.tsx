import { timing } from "@k2b/stdlib";
import { timed } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Canvas, Notice, Pane, Workspace } from "@k2b/ui/v2";
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

  // The wall display is one free drawing at display size (its type is far beyond the four v2 roles), so it stands in a
  // Canvas that fills the pane; a failed refresh is a notice laid over the drawing, so nothing on the wall moves.
  return (
    <Workspace>
      <Pane label={props.location}>
        <Canvas label={t().display}>
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
          <Show when={weather.error() && weather.data()}>
            <div class="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-lg">
              <Notice tone="warn" title={t().refreshFailed} actions={[{ label: t().refreshNow, onClick: () => schedule(0) }]}>
                {weather.error()!.message} {t().updatesResume}
              </Notice>
            </div>
          </Show>
        </Canvas>
      </Pane>
    </Workspace>
  );
}
