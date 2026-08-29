import type { DateContext } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, NoticeCard, Placeholder } from "@k2b/ui";
import { createEffect, onCleanup, Show } from "solid-js";
import type { PulseDashboardSnapshot } from "../contracts";
import { jsonFetch } from "./http";
import { PublicDashboardSections } from "./PublicDashboardSections";
import {
  type PublicDashboardDisplayHeight,
  publicDashboardRefreshDelayMs,
  resolvePublicDashboardRefreshSeconds,
} from "./public-dashboard-runtime";
import { defaultPulseDateContext } from "./workspace/helpers";
import { usePulseMessages } from "./use-messages";

type Props = {
  token: string;
  initialSnapshot: PulseDashboardSnapshot;
  initialDateConfig?: DateContext;
  displayHeight?: PublicDashboardDisplayHeight;
};

export default function PublicPulseDashboard(props: Props) {
  const t = usePulseMessages();
  const source = props.token;
  const snapshotQuery = query.create({
    source: () => source,
    initial: { source, data: props.initialSnapshot },
    load: (token, { abortSignal }) =>
      jsonFetch<PulseDashboardSnapshot>(`/api/pulse/public-dashboard/${token}`, { signal: abortSignal }, t().refreshDashboardFailed),
  });
  const snapshot = () => snapshotQuery.data()!;
  const dateContext = () => ({ ...defaultPulseDateContext, ...(props.initialDateConfig ?? {}) });
  const refreshIntervalSeconds = () => resolvePublicDashboardRefreshSeconds(snapshot().dashboard.config.refreshIntervalSeconds);

  const renderRefreshProgress = () => (
    <Show
      when={refreshIntervalSeconds()}
      fallback={
        <span class="inline-flex h-8 w-8 items-center justify-center text-zinc-500 dark:text-zinc-400">
          <i class="ti ti-player-pause text-sm" />
          <span class="sr-only">{t().manualRefresh}</span>
        </span>
      }
    >
      {(seconds) => (
        <span class="inline-flex h-8 w-8 items-center justify-center app-accent-text" title={t().refreshEveryShort({ seconds: seconds() })}>
          <svg class="-rotate-90" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="3" />
            <circle
              cx="11"
              cy="11"
              r="8"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="3"
              stroke-dasharray="50.265"
              style={{ animation: `pulse-public-refresh-progress ${seconds()}s linear infinite` }}
            />
          </svg>
          <span class="sr-only">{t().refreshEvery({ seconds: seconds() })}</span>
        </span>
      )}
    </Show>
  );

  createEffect(() => {
    const intervalSeconds = resolvePublicDashboardRefreshSeconds(snapshot().dashboard.config.refreshIntervalSeconds);
    if (intervalSeconds === null) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const schedule = (delayMs: number) => {
      if (disposed) return;
      timer = setTimeout(run, delayMs);
    };

    const nextDelay = () => publicDashboardRefreshDelayMs(intervalSeconds, failures, Math.random());

    const run = () => {
      if (disposed) return;
      if (document.hidden) {
        schedule(intervalSeconds * 1000);
        return;
      }

      snapshotQuery
        .refresh()
        .then(() => {
          const error = snapshotQuery.error();
          if (error) {
            failures += 1;
            console.warn("Pulse public dashboard refresh failed", error);
          } else failures = 0;
        })
        .finally(() => schedule(nextDelay()));
    };

    schedule(nextDelay());
    onCleanup(() => {
      disposed = true;
      if (timer) clearTimeout(timer);
      snapshotQuery.abort();
    });
  });

  return (
    <>
      <Show when={snapshotQuery.error()}>
        {(error) => (
          <div class="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-lg">
            <NoticeCard tone="warning" title={t().dashboardRefreshFailed} detail={error().message}>
              <Button variant="secondary" size="sm" onClick={() => void snapshotQuery.refresh()}>
                {t().retry}
              </Button>
            </NoticeCard>
          </div>
        )}
      </Show>
      <main
        class={`bg-zinc-50 px-4 py-6 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50 sm:px-6 lg:px-8 ${
          props.displayHeight === "full" ? "h-screen overflow-hidden" : "min-h-screen overflow-auto"
        }`}
      >
        <style>{`
        @keyframes pulse-public-refresh-progress {
          from { stroke-dashoffset: 50.265; }
          to { stroke-dashoffset: 0; }
        }
      `}</style>
        <div class={`flex w-full flex-col gap-5 ${props.displayHeight === "full" ? "h-full min-h-0" : ""}`}>
          <header class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 class="text-3xl font-semibold tracking-normal">{snapshot().dashboard.name}</h1>
            </div>
            {renderRefreshProgress()}
          </header>

          <Show
            when={snapshot().dashboard.config.layout?.sections.length}
            fallback={<Placeholder surface="paper" variant="panel" title={t().dashboardNoWidgets} />}
          >
            <section class={`space-y-6 ${props.displayHeight === "full" ? "min-h-0 flex-1 overflow-hidden" : ""}`}>
              <PublicDashboardSections snapshot={snapshot()} dateContext={dateContext()} />
            </section>
          </Show>
        </div>
      </main>
    </>
  );
}
